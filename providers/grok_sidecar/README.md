# Grok Sidecar

This directory contains the Python process that brokers every interaction with
xAI's Grok SDK. The Gemini CLI launches it with `python -m grok_sidecar` and
speaks JSON messages over stdin/stdout according to the contract documented in
`docs/design/grok-provider.md`.

## Development status

The current implementation provides a development stub so the integration can
be wired end-to-end before depending on the official SDK. It handles the
following actions:

- `initialize`: stores the API key / model configuration.
- `registerTools`: caches tool definitions forwarded from the CLI.
- `validate`: returns a canned affirmative response if the prompt references
  "grok".
- `chat`: echoes the latest user message (prefixed with `[grok-stub]`) to
  exercise the streaming pipeline.
- `toolResult`: acknowledges tool responses (tool invocation is not yet
  triggered by the stub).
- `upload`: currently raises a descriptive error because file uploads require
  real SDK support.
- `shutdown`: cleanly terminates the process.

Once we switch to the real SDK, the only module that should need substantial
modification is `service.py`.

## Running the sidecar

Ensure Python 3.10+ is available, then run::

    python -m grok_sidecar --log-level DEBUG

The process reads newline-delimited JSON from stdin and writes JSON responses to
stdout, so it is typically spawned by the CLI rather than invoked manually.

## Environment configuration

Copy `.env.example` to `.env` in this directory and populate `GROK_API_KEY`
before launching the CLI. The `.env` file is already covered by the repo's
`.gitignore`, so your secret will stay local.
