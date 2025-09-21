# Grok Provider (xAI)

Ionesco CLI ships with an experimental provider that proxies requests to xAI's
Grok models through a Python "sidecar" process. This document explains how to
set up the sidecar, supply credentials, and switch between Grok and the default
Google Gemini provider while the CLI is running.

> **Status:** The Grok integration targets the official `xai-sdk` Python
> package and currently supports streaming chat, tool calls, and document
> uploads. Treat it as alpha-quality until the upstream SDK stabilises.

## Requirements

- Python 3.10 or newer available on your PATH (the sidecar discovers `python3`
  or `python`).
- An xAI Grok API key with access to at least one model (for example
  `grok-4-fast-reasoning-latest`).
- Ionesco CLI dependencies installed via `npm install` at the repo root.

## One-Time Setup

1. **Bootstrap dependencies**

   ```bash
   npm install
   ./scripts/setup.sh
   ```

   The setup script creates a dedicated virtual environment under
   `providers/grok_sidecar/.venv`, installs `xai-sdk`, and copies
   `.env.example` to `.env` if it does not already exist.

2. **Configure secrets**

   Edit `providers/grok_sidecar/.env` and supply your credentials:

   ```bash
   GROK_API_KEY=sk-your-secret-key
   GROK_MODEL=grok-4-fast-reasoning-latest   # optional override
   ```

   If you omit `GROK_MODEL`, the sidecar falls back to
   `grok-4-fast-reasoning-latest`. The CLI also honours `GROK_MODEL_ID` for
   compatibility with other tooling.

3. **Optional:** set `GROK_DEBUG_LOG_FILE` in your shell to capture sidecar logs
   (defaults to `./grok-debug.log`).

## Launching the CLI

Use the platform helper script so the correct virtual environment is detected:

```bash
./scripts/start.sh          # Unix
scripts\start.bat           # Windows PowerShell / CMD
```

On startup the CLI inspects `providers/grok_sidecar/.env` and validates the API
key by asking the model "are you grok?".

## Switching Providers In-Session

Use the `/agent` slash command to inspect and change providers without
restarting:

```text
/agent list          # enumerate configured providers
/agent use grok      # switch to Grok
/agent use google    # switch back to Gemini
```

The footer and console summary display the active provider and model so you can
confirm which backend is responding.

## Troubleshooting

- **"GROK_API_KEY is required"** – ensure `providers/grok_sidecar/.env` is
  populated or export `GROK_API_KEY` in your shell before launching the CLI.
- **"spawn python ENOENT"** – install Python 3.10+ or set `GROK_PYTHON_BIN`
  explicitly to the interpreter path.
- **Tool call appears to hang** – tail `grok-debug.log` (or the file named in
  `GROK_DEBUG_LOG_FILE`) to confirm the sidecar is receiving tool results. If
  necessary, rerun `./scripts/setup.sh` to upgrade the `xai-sdk` dependencies.

For deeper implementation details see
[docs/design/grok-provider.md](../design/grok-provider.md).
