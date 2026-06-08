import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ChatMessage, ChatToolDefinition, ChatToolChoice, ChatToolCall } from '@freellmapi/shared/types.js';
import { routeRequest, recordRateLimitHit, recordSuccess, type RouteResult } from '../services/router.js';
import { recordRequest, recordTokens, setCooldown, getCooldownDurationForLimit } from '../services/ratelimit.js';
import { getUnifiedApiKey } from '../db/index.js';
import { contentToString } from '../lib/content.js';
import { isRetryableError, timingSafeStringEqual, extractApiToken, getStickyModel, setStickyModel, logRequest } from './proxy.js';
import { getDb } from '../db/index.js';

export const anthropicRouter = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic Messages API shim (POST /v1/messages).
//
// Translates Anthropic-format requests to the internal chat-message format,
// runs through the SAME router/retry machinery as the proxy, and translates
// results back to Anthropic Message format / SSE event stream.
//
// This allows Claude Code (and any Anthropic API client) to use freellmapi
// by setting ANTHROPIC_BASE_URL=http://localhost:3001
// ─────────────────────────────────────────────────────────────────────────────

const MAX_RETRIES = 20;

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(18).toString('hex')}`;
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

// ── Anthropic content block schemas ─────────────────────────────────────────

const textBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  citations: z.array(z.any()).optional(),
});

const imageBlockSourceSchema = z.object({
  type: z.string(),
  media_type: z.string(),
  data: z.string(),
});

const imageBlockSchema = z.object({
  type: z.literal('image'),
  source: imageBlockSourceSchema,
});

const toolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});

const toolResultContentSchema = z.union([
  z.string(),
  z.array(z.object({
    type: z.string(),
    text: z.string().optional(),
    source: z.any().optional(),
  }).passthrough()),
]);

const toolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: toolResultContentSchema,
  is_error: z.boolean().optional(),
});

const contentBlockSchema = z.union([
  textBlockSchema,
  imageBlockSchema,
  toolUseBlockSchema,
  toolResultBlockSchema,
]);

const anthropicMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(contentBlockSchema)]),
});

// ── Anthropic tool schema ───────────────────────────────────────────────────

const anthropicToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const anthropicToolChoiceSchema = z.object({
  type: z.enum(['auto', 'any', 'tool']),
  name: z.string().optional(),
}).passthrough().optional();

// ── Anthropic Messages request schema ──────────────────────────────────────

const anthropicRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(anthropicMessageSchema).min(1),
  system: z.union([z.string(), z.array(textBlockSchema)]).optional(),
  max_tokens: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  top_p: z.number().min(0).max(1).nullable().optional(),
  top_k: z.number().int().nonnegative().nullable().optional(),
  tools: z.array(anthropicToolSchema).optional(),
  tool_choice: anthropicToolChoiceSchema,
}).passthrough();

type AnthropicRequest = z.infer<typeof anthropicRequestSchema>;

// ── Translation helpers ────────────────────────────────────────────────────

/**
 * Convert Anthropic tool format to OpenAI tool definition format.
 * Anthropic: { name, description?, input_schema? }
 * OpenAI:   { type: 'function', function: { name, description?, parameters? } }
 */
function toChatTools(tools?: AnthropicRequest['tools']): ChatToolDefinition[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      ...(t.input_schema ? { parameters: t.input_schema } : {}),
    },
  }));
}

/**
 * Convert Anthropic tool_choice to OpenAI tool_choice format.
 * Anthropic: { type: 'auto'|'any'|'tool', name?: string }
 * OpenAI:   'none'|'auto'|'required'|{ type:'function', function:{name} }
 */
function toChatToolChoice(tc?: AnthropicRequest['tool_choice']): ChatToolChoice | undefined {
  if (!tc) return undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'tool' && tc.name) {
    return { type: 'function', function: { name: tc.name } };
  }
  return undefined;
}

/**
 * Extract text from Anthropic content blocks (array or string).
 */
function contentBlocksToString(content: string | Array<z.infer<typeof contentBlockSchema>>): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is z.infer<typeof textBlockSchema> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/**
 * Convert Anthropic-format messages + system prompt to internal ChatMessage[].
 */
function toChatMessages(req: AnthropicRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];

  // System prompt → system message
  if (req.system) {
    const sysText = typeof req.system === 'string'
      ? req.system
      : req.system.map((b) => b.text).join('');
    messages.push({ role: 'system', content: sysText });
  }

  for (const msg of req.messages) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Content is an array of blocks
    if (msg.role === 'assistant') {
      const text = contentBlocksToString(msg.content);
      const toolUses = msg.content.filter(
        (b): b is z.infer<typeof toolUseBlockSchema> => b.type === 'tool_use',
      );
      if (toolUses.length > 0) {
        messages.push({
          role: 'assistant',
          content: text || null,
          tool_calls: toolUses.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.input),
            },
          })),
        });
      } else {
        messages.push({ role: 'assistant', content: text });
      }
    } else {
      // user role
      const text = contentBlocksToString(msg.content);
      messages.push({ role: 'user', content: text });
    }
  }

  return messages;
}

/**
 * Extract tool_result blocks from messages and emit them as tool-role messages
 * that belong BEFORE the user message they're embedded in.
 *
 * Anthropic puts tool results inside user messages; OpenAI has them as
 * standalone tool-role messages. We scan all user messages for tool_result
 * blocks and insert them before their containing message.
 */
function extractToolResults(req: AnthropicRequest): ChatMessage[] {
  const toolResults: ChatMessage[] = [];

  for (const msg of req.messages) {
    if (msg.role !== 'user' || typeof msg.content === 'string') continue;

    for (const block of msg.content) {
      if (block.type !== 'tool_result') continue;

      const content = typeof block.content === 'string'
        ? block.content
        : contentBlocksToString(block.content as any);

      toolResults.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: content,
      });
    }
  }

  return toolResults;
}

/**
 * Build the full message array in correct order:
 * system + [interleaved tool_results + user/assistant messages]
 */
function buildFullMessages(req: AnthropicRequest): ChatMessage[] {
  const systemMsgs: ChatMessage[] = [];
  if (req.system) {
    const sysText = typeof req.system === 'string'
      ? req.system
      : req.system.map((b) => b.text).join('');
    systemMsgs.push({ role: 'system', content: sysText });
  }

  const allMessages: ChatMessage[] = [...systemMsgs];

  for (const msg of req.messages) {
    // For user messages: extract tool_results first, then add the user message
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const toolResults = msg.content.filter((b): b is z.infer<typeof toolResultBlockSchema> =>
        b.type === 'tool_result',
      );
      const nonToolBlocks = msg.content.filter((b) => b.type !== 'tool_result');

      // Insert tool results
      for (const tr of toolResults) {
        const content = typeof tr.content === 'string'
          ? tr.content
          : contentBlocksToString(tr.content as any);
        allMessages.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content,
        });
      }

      // User message from remaining blocks
      if (nonToolBlocks.length > 0) {
        const text = contentBlocksToString(nonToolBlocks as any);
        allMessages.push({ role: 'user', content: text });
      }
      continue;
    }

    // For assistant messages with potential tool_use blocks
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const text = contentBlocksToString(msg.content);
      const toolUses = msg.content.filter(
        (b): b is z.infer<typeof toolUseBlockSchema> => b.type === 'tool_use',
      );
      if (toolUses.length > 0) {
        allMessages.push({
          role: 'assistant',
          content: text || null,
          tool_calls: toolUses.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.input),
            },
          })),
        });
      } else {
        allMessages.push({ role: 'assistant', content: text });
      }
      continue;
    }

    // Simple user/assistant string messages
    allMessages.push({ role: msg.role, content: contentBlocksToString(msg.content as any) });
  }

  return allMessages;
}

// ── Response building ───────────────────────────────────────────────────────

/**
 * Build the Anthropic non-streaming response from provider results.
 */
function buildAnthropicResponse(opts: {
  id: string;
  model: string;
  text: string;
  toolCalls: ChatToolCall[];
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
}) {
  const content: any[] = [];

  if (opts.text) {
    content.push({ type: 'text', text: opts.text });
  }

  for (const tc of opts.toolCalls) {
    content.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments || '{}'),
    });
  }

  // Map OpenAI finish_reason to Anthropic stop_reason
  let stopReason = opts.stopReason;
  if (stopReason === 'stop') stopReason = 'end_turn';
  else if (stopReason === 'tool_calls') stopReason = 'tool_use';
  else if (stopReason === 'length') stopReason = 'max_tokens';
  else if (stopReason === 'content_filter') stopReason = 'end_turn';
  else if (!stopReason) stopReason = 'end_turn';

  return {
    id: opts.id,
    type: 'message',
    role: 'assistant',
    content,
    model: opts.model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: opts.inputTokens,
      output_tokens: opts.outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

/**
 * Convert OpenAI finish_reason to Anthropic stop_reason.
 */
function mapFinishReason(finishReason: string | null): string {
  switch (finishReason) {
    case 'stop': return 'end_turn';
    case 'tool_calls': return 'tool_use';
    case 'length': return 'max_tokens';
    case 'content_filter': return 'end_turn';
    default: return 'end_turn';
  }
}

// Maximum estimated output for token-count estimation
const DEFAULT_MAX_TOKENS = 4096;

// ── Route handler ──────────────────────────────────────────────────────────

anthropicRouter.post('/messages', async (req: Request, res: Response) => {
  const start = Date.now();

  // Authenticate with the unified API key (same as proxy)
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return;
  }

  const parsed = anthropicRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const reqData = parsed.data;
  const stream = reqData.stream ?? false;

  // Build messages
  const messages = buildFullMessages(reqData);
  const tools = toChatTools(reqData.tools);
  const tool_choice = toChatToolChoice(reqData.tool_choice);
  const completionOpts = {
    temperature: reqData.temperature ?? undefined,
    max_tokens: reqData.max_tokens ?? undefined,
    top_p: reqData.top_p ?? undefined,
    tools,
    tool_choice,
  };

  // Token estimation
  const estimatedInputTokens = messages.reduce(
    (sum, m) => sum + Math.ceil(contentToString(m.content).length / 4),
    0,
  );
  const estimatedTotal = estimatedInputTokens + (reqData.max_tokens ?? DEFAULT_MAX_TOKENS);

  // Model pinning (like the proxy): if the user specifies a model, try it;
  // otherwise fall back to sticky session or let the router decide.
  const autoModelIds = new Set(['auto', 'claude-sonnet-4-20250514', 'claude-3-5-sonnet-latest',
    'claude-3-opus-latest', 'claude-3-haiku-latest', 'claude-sonnet-4.5']);
  let preferredModel: number | undefined;
  if (reqData.model && !autoModelIds.has(reqData.model)) {
    const db = getDb();
    const enabled = db.prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1').get(reqData.model) as { id: number } | undefined;
    if (enabled) {
      preferredModel = enabled.id;
    } else {
      const disabled = db.prepare('SELECT id FROM models WHERE model_id = ?').get(reqData.model) as { id: number } | undefined;
      const reason = disabled ? 'is disabled' : 'is not in the catalog';
      res.status(400).json({
        error: {
          message: `Model '${reqData.model}' ${reason}. Use 'auto' (or omit the 'model' field) to auto-route.`,
          type: 'invalid_request_error',
        },
      });
      return;
    }
  } else {
    preferredModel = getStickyModel(messages);
  }
  const responseId = newId('msg');

  const skipKeys = new Set<string>();
  let lastError: any = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = routeRequest(estimatedTotal, skipKeys.size > 0 ? skipKeys : undefined, preferredModel);
    } catch (err: any) {
      const status = lastError ? 429 : (err.status ?? 503);
      const message = lastError
        ? `All models rate-limited. Last error: ${lastError.message}`
        : err.message;
      const type = lastError ? 'rate_limit_error' : 'routing_error';
      res.status(status).json({
        error: { type, message },
      });
      return;
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    try {
      if (stream) {
        // ── Anthropic-style SSE streaming ──────────────────────────────
        let streamStarted = false;
        let firstTextBlock = false;     // whether we've emitted content_block_start for text
        let textAccumulator = '';       // accumulated text for this turn
        const toolBlocks = new Map<number, {
          id: string;
          name: string;
          args: string;
          blockStarted: boolean;
        }>();
        let totalOutputTokens = 0;

        try {
          const gen = route.provider.streamChatCompletion(
            route.apiKey, messages, route.modelId, completionOpts,
          );

          for await (const chunk of gen) {
            // Start stream on first chunk
            if (!streamStarted) {
              res.setHeader('Content-Type', 'text/event-stream');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('Connection', 'keep-alive');
              res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
              if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
              streamStarted = true;

              // Emit message_start
              const skeleton = {
                id: responseId,
                type: 'message',
                role: 'assistant',
                content: [] as any[],
                model: route.displayName || route.modelId,
                stop_reason: null,
                stop_sequence: null,
                usage: {
                  input_tokens: estimatedInputTokens,
                  output_tokens: 0,
                },
              };
              sseWrite(res, 'message_start', { message: skeleton });
            }

            const delta = chunk.choices?.[0]?.delta;
            const finishReason = chunk.choices?.[0]?.finish_reason;
            if (!delta) continue;

            // Text content
            const text = delta.content ?? '';
            if (text) {
              if (!firstTextBlock) {
                sseWrite(res, 'content_block_start', {
                  index: 0,
                  content_block: { type: 'text', text: '' },
                });
                firstTextBlock = true;
              }
              sseWrite(res, 'content_block_delta', {
                index: 0,
                delta: { type: 'text_delta', text },
              });
              textAccumulator += text;
              totalOutputTokens += Math.ceil(text.length / 4);
            }

            // Tool call deltas
            for (const tc of delta.tool_calls ?? []) {
              const idx = (tc as any).index ?? 0;
              let block = toolBlocks.get(idx);

              if (!block) {
                const toolId = tc.id || newId('toolu');
                const name = tc.function?.name ?? '';
                block = { id: toolId, name, args: '', blockStarted: false };
                toolBlocks.set(idx, block);
              }

              // Update name on first fragment
              if (tc.function?.name && !block.name) {
                block.name = tc.function.name;
              }

              const argFrag = tc.function?.arguments ?? '';
              if (argFrag) block.args += argFrag;

              if (!block.blockStarted) {
                // Close any open text block before starting tool use
                if (firstTextBlock) {
                  sseWrite(res, 'content_block_stop', { index: 0 });
                  firstTextBlock = false;
                }
                sseWrite(res, 'content_block_start', {
                  index: idx + (textAccumulator ? 1 : 0),
                  content_block: {
                    type: 'tool_use',
                    id: block.id,
                    name: block.name,
                    input: {},
                  },
                });
                block.blockStarted = true;
              }

              if (argFrag) {
                sseWrite(res, 'content_block_delta', {
                  index: idx + (textAccumulator ? 1 : 0),
                  delta: { type: 'input_json_delta', partial_json: argFrag },
                });
              }
            }
          }

          // ── Close all open blocks ────────────────────────────────────
          if (firstTextBlock) {
            sseWrite(res, 'content_block_stop', { index: 0 });
          }
          for (const [idx, block] of toolBlocks) {
            if (block.blockStarted) {
              sseWrite(res, 'content_block_stop', {
                index: idx + (textAccumulator ? 1 : 0),
              });
            }
          }

          // ── message_delta + message_stop ─────────────────────────────
          const stopReason = finishReason ? mapFinishReason(finishReason) : 'end_turn';

          // Try to get real output_tokens from usage if the last chunk includes it
          let finalOutputTokens = totalOutputTokens;
          if (chunk?.usage?.completion_tokens) {
            finalOutputTokens = chunk.usage.completion_tokens;
          }

          sseWrite(res, 'message_delta', {
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: finalOutputTokens },
          });
          sseWrite(res, 'message_stop', {});

          res.end();

          recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + finalOutputTokens);
          recordSuccess(route.modelDbId);
          setStickyModel(messages, route.modelDbId);
          logRequest(route.platform, route.modelId, route.keyId, 'success',
            estimatedInputTokens, finalOutputTokens, Date.now() - start, null);
          return;

        } catch (streamErr: any) {
          if (streamStarted) {
            // Mid-stream — can't recover, close cleanly
            console.error(`[Anthropic] Mid-stream error from ${route.displayName}:`, streamErr.message);
            try { res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error' } })}\n\n`); } catch { /* socket gone */ }
            try { res.end(); } catch { /* socket gone */ }
            logRequest(route.platform, route.modelId, route.keyId, 'error',
              estimatedInputTokens, 0, Date.now() - start, streamErr.message);
            return;
          }
          throw streamErr;
        }

      } else {
        // ── Non-streaming request ──────────────────────────────────────
        const result = await route.provider.chatCompletion(
          route.apiKey, messages, route.modelId, completionOpts,
        );

        const msg = result.choices[0]?.message;
        const text = contentToString(msg?.content ?? '');
        const toolCalls: ChatToolCall[] = (msg?.tool_calls ?? []).map((tc) => ({
          id: tc.id,
          type: 'function',
          function: tc.function,
        }));
        const promptTokens = result.usage?.prompt_tokens ?? estimatedInputTokens;
        const completionTokens = result.usage?.completion_tokens ?? Math.ceil(text.length / 4);
        const finishReason = result.choices[0]?.finish_reason;

        recordTokens(route.platform, route.modelId, route.keyId, result.usage?.total_tokens ?? 0);
        recordSuccess(route.modelDbId);
        setStickyModel(messages, route.modelDbId);

        res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
        if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));

        res.json(buildAnthropicResponse({
          id: responseId,
          model: route.displayName || route.modelId,
          text,
          toolCalls,
          stopReason: finishReason,
          inputTokens: promptTokens,
          outputTokens: completionTokens,
        }));

        logRequest(route.platform, route.modelId, route.keyId, 'success',
          promptTokens, completionTokens, Date.now() - start, null);
        return;
      }
    } catch (err: any) {
      const latency = Date.now() - start;
      logRequest(route.platform, route.modelId, route.keyId, 'error',
        estimatedInputTokens, 0, latency, err.message);

      if (isRetryableError(err)) {
        skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
        setCooldown(route.platform, route.modelId, route.keyId,
          getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, {
            rpd: route.rpdLimit,
            tpd: route.tpdLimit,
          }),
        );
        recordRateLimitHit(route.modelDbId);
        lastError = err;
        console.log(`[Anthropic] ${(err.message ?? '').slice(0, 60)} from ${route.displayName}, falling back (attempt ${attempt + 1}/${MAX_RETRIES})`);
        continue;
      }

      res.status(502).json({
        error: { message: `Provider error (${route.displayName}): ${err.message}`, type: 'provider_error' },
      });
      return;
    }
  }

  res.status(429).json({
    error: {
      message: `All models rate-limited after ${MAX_RETRIES} attempts. Last: ${lastError?.message}`,
      type: 'rate_limit_error',
    },
  });
});

// ── SSE helper (Anthropic format) ──────────────────────────────────────────

function sseWrite(res: Response, event: string, data: Record<string, unknown>) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── Anthropic /v1/models (returns router model list with Anthropic-style fields) ──

anthropicRouter.get('/models', (_req: Request, res: Response) => {
  const db = getDb();
  const models = db.prepare(
    'SELECT platform, model_id, display_name, context_window FROM models WHERE enabled = 1 ORDER BY intelligence_rank',
  ).all() as any[];

  res.json({
    data: models.map((m: any) => ({
      type: 'model',
      id: m.model_id,
      display_name: m.display_name,
      created_at: new Date().toISOString(),
      context_window: m.context_window ?? 200000,
    })),
  });
});
