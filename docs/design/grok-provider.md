# Grok Provider Sidecar Contract

This note defines the integration contract between the Gemini CLI (TypeScript) and
the Grok provider sidecar (Python). The goal is to allow the CLI to keep the
existing tool/plugin infrastructure while delegating every Grok-specific operation
to the official xAI Python SDK.

## Process lifecycle & entry point

- The CLI spawns the sidecar as a child process (initial version uses `stdin` /
  `stdout` JSON messages; we can promote to a local HTTP server later).
- The sidecar writes a single line JSON message per response for ease of parsing.
- CLI sends a `shutdown` request at exit; the sidecar cleans up and terminates.
- If the sidecar crashes or exits unexpectedly, the CLI tears down the provider,
  surfaces an error to the user, and offers to restart.
- The reference implementation lives in `providers/grok_sidecar` and exposes an
  entry point via `python -m grok_sidecar`. Consumers should ensure the repo
  root is on `PYTHONPATH` (the CLI will set this automatically when spawning the
  process).
- Authentication uses the `GROK_API_KEY` environment variable; if unset the
  provider rejects requests during the `initialize` step.

## Transport

- Encoding: UTF-8 JSON lines (`\n`-terminated).
- Each request includes a `requestId` so responses can be correlated.
- Responses mirror the `requestId` and include either a `result` payload or an
  `error` object `{ message: string, code?: string }`.
- Streaming responses (model output or tool events) emit interim `event`
  messages sharing the same `requestId`; the final message uses `type: "result"`
  to signal completion.

### Message envelope

```json
// request from CLI -> sidecar
{
  "type": "request",
  "requestId": "uuid",
  "action": "chat" | "registerTools" | "toolResult" | "validate" | "upload" | "shutdown" | ...,
  "payload": { /* action-specific */ }
}

// response/event from sidecar -> CLI
{
  "type": "result" | "event" | "error",
  "requestId": "uuid",
  "payload"?: {},
  "error"?: { "message": string, "code"?: string }
}
```

## Actions

### `initialize`

First call after process launch. Provides auth/config.

**Request payload**

```json
{
  "apiKey": "...", // required
  "model": "grok-beta", // optional explicit model id
  "pythonPath": "/usr/bin/python", // optional, used only for diagnostics
  "featureFlags": {
    // future compatibility
    "collections": true
  }
}
```

**Response**: `{ "status": "ok" }` with optional `capabilities` describing
available features (e.g., `{ "supportsCollections": true }`).

### `validate`

Runs the provider validation handshake (“Are you grok?”).

- CLI payload: `{ "prompt": "are you grok?" }`
- Sidecar sends one or more `event` messages for streaming text, then a final
  `result` with `{ "passed": boolean, "rawResponse": string }`.

CLI decides success by checking `passed` (true => provider ready; false => show error).

### `chat`

Core completion endpoint.

**Request payload**

```json
{
  "sessionId": "cli-session-id",
  "messages": [
    { "role": "system" | "user" | "assistant" | "tool", "content": [ { "type": "text", "text": "..." } ] }
  ],
  "tools": [ { "name": "search_code", "description": "...", "schema": { ... } } ],
  "options": {
    "temperature": 0.2,
    "maxOutputTokens": 1024,
    "stream": true
  }
}
```

**Response flow**

- Streaming token chunks: `type: "event", payload: { "event": "delta", "text": "partial" }`
- Tool call request: `event` with `{ "event": "toolCall", "name": "search_code", "arguments": { ... }, "callId": "id" }`
- Final model reply: `type: "result"` with
  `{ "message": { "role": "assistant", "content": [ ... ] }, "usage": { "inputTokens": 123, "outputTokens": 456 } }`

### `toolResult`

CLI responds to a `toolCall` event by running the local tool and sending the
result back.

**Request payload**

```json
{
  "callId": "id", // from prior toolCall event
  "content": [{ "type": "text", "text": "tool output" }],
  "isError": false
}
```

Sidecar correlates the tool result with the pending call and resumes the Grok SDK invocation.

### `registerTools`

Pushes the current tool schema to the sidecar so it can register them with the SDK.

**Payload**: `{ "tools": [ { "name": string, "description": string, "schema": object } ] }`

Sidecar caches these definitions for subsequent `chat` requests.

### `upload`

Uploads a file (used for collections).

**Payload**

```json
{
  "collectionId": "optional",
  "path": "/absolute/path/to/file",
  "mimeType": "text/plain"
}
```

The sidecar handles reading the file (or expects it streamed in future). Response
includes IDs/metadata returned by the Grok SDK.

### `shutdown`

No payload. Sidecar performs cleanup and exits.

## Error handling

- Every response may include `{ "error": { "message": string, "code"?: string } }`.
- CLI treats `code` (if provided) as machine-readable (`AUTH_FAILED`,
  `MODEL_NOT_FOUND`, `TOOL_CALL_ERROR`, etc.) for UI messaging.
- Fatal errors (e.g., `initialize` failure) should propagate immediately and the
  CLI stops using the provider.

## Open questions / TODO

- Decide how to stream binary uploads (initial cut can read files directly from
  disk in Python, so CLI sends the path; long-term we may stream content to the
  sidecar for ephemeral files).
- Evaluate whether to keep the process resident or spin per request. Staying
  resident simplifies tool registration and avoids repeated SDK init.
- Authentication refresh (e.g., rotating keys) may require a `reloadConfig` RPC.
- Logging/telemetry: expose a simple `event` channel for warning/info logs that
  the CLI can mirror to the user in debug mode.
