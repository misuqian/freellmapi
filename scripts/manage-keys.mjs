#!/usr/bin/env node
/**
 * FreeLLMAPI key management CLI
 *
 * Usage:
 *   node scripts/manage-keys.mjs
 *   node scripts/manage-keys.mjs --url http://localhost:3001
 *
 * Session token is cached in ~/.freellmapi-token (mode 0600).
 * Requires Node 18+ (native fetch).
 */

import { createInterface } from 'readline';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const BASE_URL = (() => {
  const idx = process.argv.indexOf('--url');
  return idx !== -1 ? process.argv[idx + 1] : (process.env.API_URL ?? 'http://localhost:3001');
})();

const TOKEN_FILE = join(homedir(), '.freellmapi-token');

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const USE_COLOR = process.stdout.isTTY;
const esc = USE_COLOR ? (code) => `\x1b[${code}m` : () => '';
const reset = esc('0');
const clr = {
  bold:   (s) => `${esc('1')}${s}${reset}`,
  dim:    (s) => `${esc('2')}${s}${reset}`,
  red:    (s) => `${esc('31')}${s}${reset}`,
  green:  (s) => `${esc('32')}${s}${reset}`,
  yellow: (s) => `${esc('33')}${s}${reset}`,
  cyan:   (s) => `${esc('36')}${s}${reset}`,
};

function sep(char = '─', len = 52) {
  console.log(clr.dim(char.repeat(len)));
}

function printMenu(title, items) {
  console.log();
  console.log(clr.bold(clr.cyan(`  ${title}`)));
  sep();
  items.forEach((item, i) => console.log(`  ${clr.yellow(`${i + 1}.`)} ${item}`));
  sep();
}

// ── Readline helpers ──────────────────────────────────────────────────────────
const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise((resolve) => rl.question(question, (ans) => resolve(ans.trim())));
}

function askSecret(label) {
  return new Promise((resolve) => {
    if (!process.stdout.isTTY) {
      // Non-TTY: fall back to plain readline (e.g. piped input)
      rl.question(label, (ans) => resolve(ans.trim()));
      return;
    }
    process.stdout.write(label);
    let val = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    function onData(ch) {
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(val);
      } else if (ch === '') {
        process.exit(0);
      } else if (ch === '') {
        if (val.length > 0) { val = val.slice(0, -1); process.stdout.write('\b \b'); }
      } else {
        val += ch;
        process.stdout.write('*');
      }
    }
    process.stdin.on('data', onData);
  });
}

async function pickNumber(prompt, max) {
  while (true) {
    const raw = await ask(prompt);
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1 && n <= max) return n;
    console.log(clr.red(`  Enter a number between 1 and ${max}.`));
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
async function api(method, path, body = null, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ── Token cache ───────────────────────────────────────────────────────────────
function loadToken()       { try { return existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8').trim() : null; } catch { return null; } }
function saveToken(tok)    { writeFileSync(TOKEN_FILE, tok, { mode: 0o600 }); }
function clearToken()      { try { unlinkSync(TOKEN_FILE); } catch {} }

// ── Platform list ─────────────────────────────────────────────────────────────
const PLATFORMS = [
  { id: 'google',       name: 'Google Gemini' },
  { id: 'groq',         name: 'Groq' },
  { id: 'cerebras',     name: 'Cerebras' },
  { id: 'sambanova',    name: 'SambaNova' },
  { id: 'nvidia',       name: 'NVIDIA NIM' },
  { id: 'mistral',      name: 'Mistral' },
  { id: 'openrouter',   name: 'OpenRouter' },
  { id: 'github',       name: 'GitHub Models' },
  { id: 'cohere',       name: 'Cohere' },
  { id: 'cloudflare',   name: 'Cloudflare Workers AI' },
  { id: 'zhipu',        name: 'Zhipu AI' },
  { id: 'ollama',       name: 'Ollama Cloud' },
  { id: 'kilo',         name: 'Kilo Gateway' },
  { id: 'pollinations', name: 'Pollinations' },
  { id: 'llm7',         name: 'LLM7' },
  { id: 'huggingface',  name: 'HuggingFace Router' },
  { id: 'opencode',     name: 'OpenCode Zen' },
];

// ── Auth ──────────────────────────────────────────────────────────────────────
async function ensureAuth() {
  let status;
  try {
    const r = await api('GET', '/api/auth/status');
    status = r.data;
  } catch {
    console.error(clr.red(`\n  Cannot reach server at ${BASE_URL}`));
    console.error(clr.dim('  Start it with: npm run dev -w server\n'));
    process.exit(1);
  }

  // Try cached token
  const cached = loadToken();
  if (cached) {
    const me = await api('GET', '/api/auth/me', null, cached);
    if (me.ok) {
      console.log(clr.dim(`  Authenticated as ${me.data.email}`));
      return cached;
    }
    clearToken();
  }

  if (status.needsSetup) {
    console.log(clr.yellow('\n  First run — create your admin account.'));
    const email    = await ask('  Email: ');
    const password = await askSecret('  Password (min 8 chars): ');
    const r = await api('POST', '/api/auth/setup', { email, password });
    if (!r.ok) {
      console.error(clr.red(`  Setup failed: ${r.data?.error?.message}`));
      process.exit(1);
    }
    console.log(clr.green('  Account created.'));
    saveToken(r.data.token);
    return r.data.token;
  }

  // Normal login
  console.log(clr.cyan('\n  Please log in.'));
  const email    = await ask('  Email: ');
  const password = await askSecret('  Password: ');
  const r = await api('POST', '/api/auth/login', { email, password });
  if (!r.ok) {
    console.error(clr.red(`  Login failed: ${r.data?.error?.message}`));
    process.exit(1);
  }
  console.log(clr.green('  Logged in.'));
  saveToken(r.data.token);
  return r.data.token;
}

// ── Add regular key ───────────────────────────────────────────────────────────
async function addKey(token) {
  printMenu('Add API Key', PLATFORMS.map((p) => p.name));
  const idx      = await pickNumber('  Select platform: ', PLATFORMS.length);
  const platform = PLATFORMS[idx - 1];

  const key = await askSecret(`  ${platform.name} API key: `);
  if (!key) { console.log(clr.yellow('  Cancelled.')); return; }

  const labelRaw = await ask('  Label (optional, Enter to skip): ');
  const label    = labelRaw || undefined;

  const r = await api('POST', '/api/keys', { platform: platform.id, key, label }, token);
  if (!r.ok) { console.error(clr.red(`  Failed: ${r.data?.error?.message}`)); return; }
  console.log(clr.green(`  Added ${platform.name}: ${r.data.maskedKey}`));
}

// ── Add custom provider ───────────────────────────────────────────────────────
async function addCustomProvider(token) {
  console.log();
  console.log(clr.bold(clr.cyan('  Add Custom OpenAI-Compatible Provider')));
  sep();

  const baseUrl = await ask('  Base URL (e.g. http://localhost:11434/v1): ');
  if (!baseUrl) { console.log(clr.yellow('  Cancelled.')); return; }

  const model = await ask('  Model ID: ');
  if (!model) { console.log(clr.yellow('  Cancelled.')); return; }

  const displayName = await ask(`  Display name (Enter for "${model}"): `);
  const apiKey      = await askSecret('  API key (Enter for none): ');
  const label       = await ask('  Label (optional): ');

  const body = {
    baseUrl,
    model,
    ...(displayName && { displayName }),
    ...(apiKey      && { apiKey }),
    ...(label       && { label }),
  };

  const r = await api('POST', '/api/keys/custom', body, token);
  if (!r.ok) { console.error(clr.red(`  Failed: ${r.data?.error?.message}`)); return; }
  console.log(clr.green(`  Custom provider added: ${r.data.displayName ?? model} @ ${baseUrl}`));
}

// ── List keys ─────────────────────────────────────────────────────────────────
async function listKeys(token) {
  const r = await api('GET', '/api/keys', null, token);
  if (!r.ok) { console.error(clr.red('  Failed to fetch keys.')); return null; }
  const keys = r.data;

  console.log();
  if (keys.length === 0) { console.log(clr.dim('  No keys configured.')); return keys; }

  console.log(clr.bold('  Configured keys:'));
  sep();
  for (const k of keys) {
    const statusStr =
      k.status === 'healthy'      ? clr.green(k.status) :
      k.status === 'rate_limited' ? clr.yellow(k.status) :
      k.status === 'invalid'      ? clr.red(k.status) :
                                    clr.dim(k.status);
    const en    = k.enabled ? clr.green('✓') : clr.red('✗');
    const label = k.label   ? clr.dim(` (${k.label})`) : '';
    const extra = k.baseUrl ? clr.dim(` → ${k.baseUrl}`) : '';
    console.log(`  ${en} ${clr.cyan(k.platform.padEnd(13))} ${k.maskedKey}${label}${extra}  ${statusStr}  ${clr.dim(`id:${k.id}`)}`);
  }
  sep();
  return keys;
}

// ── Delete key ────────────────────────────────────────────────────────────────
async function deleteKey(token) {
  const keys = await listKeys(token);
  if (!keys?.length) return;

  const raw = await ask('  Key ID to delete (Enter to cancel): ');
  if (!raw) return;
  const id = parseInt(raw, 10);
  if (isNaN(id)) { console.log(clr.yellow('  Invalid ID.')); return; }

  const r = await api('DELETE', `/api/keys/${id}`, null, token);
  if (!r.ok) { console.error(clr.red(`  Failed: ${r.data?.error?.message}`)); return; }
  console.log(clr.green(`  Key ${id} deleted.`));
}

// ── Fallback settings ─────────────────────────────────────────────────────────
async function fallbackSettings(token) {
  while (true) {
    const rf = await api('GET', '/api/fallback/routing', null, token);
    const strategy = rf.ok ? rf.data.strategy : '?';

    printMenu(
      `Fallback Settings  [strategy: ${clr.yellow(strategy)}]`,
      [
        'View fallback chain',
        'Change routing strategy',
        'Sort fallback chain by preset',
        'Toggle model enabled/disabled',
        'Back',
      ],
    );
    const choice = await pickNumber('  Select: ', 5);

    if (choice === 1) {
      // ── View chain ──────────────────────────────────────────────────────────
      const r = await api('GET', '/api/fallback', null, token);
      if (!r.ok) { console.error(clr.red('  Failed.')); continue; }
      const sorted = [...r.data].sort((a, b) => a.effectivePriority - b.effectivePriority);
      console.log();
      console.log(clr.bold('  Fallback chain (effective order):'));
      sep();
      sorted.forEach((m, i) => {
        const en   = m.enabled    ? clr.green('✓') : clr.red('✗');
        const keys = m.keyCount > 0 ? clr.green(`${m.keyCount}k`) : clr.red('0k');
        const pen  = m.penalty > 0  ? clr.yellow(` +${m.penalty}pen`) : '';
        const size = m.sizeLabel    ? clr.dim(` [${m.sizeLabel}]`) : '';
        console.log(
          `  ${en} ${String(i + 1).padStart(2)}. [id:${m.modelDbId}] ` +
          `${clr.cyan(m.displayName.padEnd(34))} ${keys}${pen}${size}  ` +
          clr.dim(m.platform),
        );
      });
      sep();

    } else if (choice === 2) {
      // ── Change routing strategy ─────────────────────────────────────────────
      const strategies = ['priority', 'balanced', 'smartest', 'fastest', 'reliable'];
      const descriptions = [
        'priority   — fixed manual chain order',
        'balanced   — mix of speed, intelligence, reliability',
        'smartest   — favor highest-intelligence models',
        'fastest    — favor lowest-latency models',
        'reliable   — favor historically stable models',
      ];
      printMenu('Routing Strategy', descriptions);
      const si = await pickNumber('  Select: ', strategies.length);
      const r  = await api('PUT', '/api/fallback/routing', { strategy: strategies[si - 1] }, token);
      if (!r.ok) { console.error(clr.red(`  Failed: ${r.data?.error?.message}`)); continue; }
      console.log(clr.green(`  Strategy → ${strategies[si - 1]}`));

    } else if (choice === 3) {
      // ── Sort by preset ──────────────────────────────────────────────────────
      const presets      = ['intelligence', 'speed', 'budget'];
      const descriptions = [
        'intelligence — smartest models first (Frontier > Large > Medium > Small)',
        'speed        — fastest models first',
        'budget       — highest monthly token quota first',
      ];
      printMenu('Sort Preset', descriptions);
      const pi = await pickNumber('  Select: ', presets.length);
      const r  = await api('POST', `/api/fallback/sort/${presets[pi - 1]}`, null, token);
      if (!r.ok) { console.error(clr.red(`  Failed: ${r.data?.error?.message}`)); continue; }
      console.log(clr.green(`  Chain sorted by: ${presets[pi - 1]}`));

    } else if (choice === 4) {
      // ── Toggle model ────────────────────────────────────────────────────────
      const r = await api('GET', '/api/fallback', null, token);
      if (!r.ok) continue;
      const sorted = [...r.data].sort((a, b) => a.priority - b.priority);
      console.log();
      sorted.forEach((m) => {
        const en = m.enabled ? clr.green('✓') : clr.red('✗');
        console.log(`  ${en} [id:${m.modelDbId}] ${m.displayName} ${clr.dim(`(${m.platform})`)}`);
      });
      sep();
      const raw = await ask('  Enter model DB ID to toggle (Enter to cancel): ');
      if (!raw) continue;
      const dbId   = parseInt(raw, 10);
      const target = r.data.find((m) => m.modelDbId === dbId);
      if (!target) { console.log(clr.yellow('  Not found.')); continue; }

      const updates = [{ modelDbId: dbId, priority: target.priority, enabled: !target.enabled }];
      const ur = await api('PUT', '/api/fallback', updates, token);
      if (!ur.ok) { console.error(clr.red(`  Failed: ${ur.data?.error?.message}`)); continue; }
      const nowState = !target.enabled ? clr.green('enabled') : clr.red('disabled');
      console.log(clr.green(`  ${target.displayName} → ${nowState}`));

    } else {
      break;
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log();
  console.log(clr.bold(clr.cyan('  FreeLLMAPI Key Manager')));
  console.log(clr.dim(`  Server: ${BASE_URL}`));
  sep('═');

  const token = await ensureAuth();

  while (true) {
    printMenu('Main Menu', [
      'Add API key',
      'Add custom provider',
      'List keys',
      'Delete a key',
      'Fallback settings',
      'Exit',
    ]);
    const choice = await pickNumber('  Select: ', 6);
    if (choice === 1) await addKey(token);
    else if (choice === 2) await addCustomProvider(token);
    else if (choice === 3) await listKeys(token);
    else if (choice === 4) await deleteKey(token);
    else if (choice === 5) await fallbackSettings(token);
    else break;
  }

  rl.close();
  console.log(clr.dim('\n  Bye.\n'));
}

main().catch((e) => {
  console.error(clr.red(`\n  Unexpected error: ${e.message}`));
  process.exit(1);
});
