# CLI Key Manager

`scripts/manage-keys.mjs` is a terminal-based alternative to the dashboard UI. It lets you add provider keys, configure the fallback chain, and manage settings without opening a browser — useful for headless servers or scripted setup.

**Requirements:** Node.js 18+, server running at `http://localhost:3001` (or the URL you specify).

## Running

```bash
npm run keys

# custom server URL
npm run keys -- --url http://localhost:4000

# or via environment variable
API_URL=http://my-server:3001 npm run keys
```

## First run

On first launch the script calls `GET /api/auth/status`. If no admin account exists yet, it prompts you to create one:

```
First run — create your admin account.
  Email: admin@example.com
  Password (min 8 chars): ********
  Account created.
```

The session token is saved to `~/.freellmapi-token` (mode `0600`) so subsequent runs skip the login step. When the token expires the script automatically prompts for credentials again.

## Main menu

```
  1. Add API key
  2. Add custom provider
  3. List keys
  4. Delete a key
  5. Fallback settings
  6. Exit
```

### Add API key

Select a provider from the numbered list (Google, Groq, Cerebras, SambaNova, NVIDIA, Mistral, OpenRouter, GitHub Models, Cohere, Cloudflare, Zhipu, Ollama, Kilo, Pollinations, LLM7, HuggingFace, OpenCode), paste the API key (input is masked), and optionally enter a label.

### Add custom provider

Register any OpenAI-compatible endpoint — a local llama.cpp, LM Studio, vLLM instance, or a remote gateway:

| Prompt | Example |
|--------|---------|
| Base URL | `http://localhost:11434/v1` |
| Model ID | `llama3.2` |
| Display name | `Local Llama 3.2` (optional) |
| API key | leave blank for no-key servers |
| Label | optional |

The model is added to the fallback chain automatically.

### List keys

Prints all configured keys with masked values, status (`healthy` / `rate_limited` / `invalid` / `unknown`), enabled state, and database ID.

### Delete a key

Lists all keys, then asks for the ID to delete.

## Fallback settings

Sub-menu for the fallback chain and routing strategy.

```
  1. View fallback chain
  2. Change routing strategy
  3. Sort fallback chain by preset
  4. Toggle model enabled/disabled
  5. Back
```

### View fallback chain

Shows every model in effective-priority order (base priority + any active rate-limit penalties), along with the number of enabled keys for that platform and the model's size tier.

### Change routing strategy

| Strategy | Behaviour |
|----------|-----------|
| `priority` | Fixed manual chain order |
| `balanced` | Weighted mix of speed, intelligence, and reliability |
| `smartest` | Highest-intelligence models first |
| `fastest` | Lowest-latency models first |
| `reliable` | Historically stable models first |

### Sort fallback chain by preset

| Preset | Sort key |
|--------|----------|
| `intelligence` | Size tier (Frontier → Large → Medium → Small), then per-provider intelligence rank |
| `speed` | Speed rank ascending |
| `budget` | Monthly token quota descending |

### Toggle model enabled/disabled

Lists models with their database IDs. Enter an ID to flip its enabled state. Disabled models are skipped by the router entirely.
