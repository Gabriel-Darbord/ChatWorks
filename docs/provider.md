# Local agent provider

ChatWorks can expose one ChatGPT conversation as a local OpenAI-compatible chat-completions provider. An agent IDE or other client sends a model turn to ChatWorks; ChatWorks relays it through the selected ChatGPT UI, translates tool requests into native `tool_calls`, and returns tool results to the same chat until the turn is complete.

This mode is client-neutral. OpenCode is one supported configuration example, not a requirement.

## Start the provider

Select the ChatGPT application and serve the currently displayed chat:

```sh
npm start -- --app classic provider
npm start -- --app desktop provider
```

To select a named chat once at startup:

```sh
npm start -- --app classic provider --chat "ChatWorks provider"
```

Options:

- `--chat <exact title|current>`: choose the conversation. The default is `current`, which performs no sidebar navigation.
- `--port <number>`: choose the loopback port. The default is `32123`; valid values are `1` through `65535`.

The server binds only to `127.0.0.1`. It does not require or validate an API key. If a client requires a non-empty key, use any local placeholder value.

## Client configuration

Configure an OpenAI-compatible client with:

- Base URL: `http://127.0.0.1:32123/v1`
- Model: `chatworks`
- Tool or function calling: enabled when the client supports it
- Streaming: optional

The provider exposes:

- `GET /v1/models`
- `POST /v1/chat/completions`

Requests are serialized because one provider process controls one UI conversation. Run at most one provider process per running ChatGPT application; separate ports do not isolate two processes that control the same UI.

## Basic request

This example does not supply client tools:

```sh
curl http://127.0.0.1:32123/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "chatworks",
    "messages": [
      {"role": "user", "content": "Summarize the current project."}
    ]
  }'
```

ChatWorks accepts text messages with `system`, `developer`, `user`, `assistant`, and `tool` roles. OpenAI-style text content arrays are supported; non-text content parts are rejected with an actionable error.

## Tool loop

Client tools are passed through without client-specific rewriting. Their names, descriptions, and JSON input schemas are presented to ChatGPT. The assistant requests operations using one or more ordered `tools` fences, with one JSON object per non-empty line:

````text
```tools
{"name":"read","input":{"filePath":"src/app.ts"}}
{"name":"grep","input":{"pattern":"TODO"}}
```
````

ChatWorks validates the complete batch before returning native tool calls. A malformed batch does not execute a valid prefix. Independent calls should share as few blocks as practical; dependent calls should wait for earlier results.

ChatWorks also adds namespaced control tools for catalog discovery and turn completion. Their exact names are included in the prompt. The default namespace is `chatworks_internal`; if a client tool already uses either generated name, both controls move to the next free numbered namespace.

Tool outputs are clearly delimited as untrusted data before they are returned to ChatGPT. Instructions found inside tool output are not part of the agent or user prompt.

## Streaming and errors

Set `stream: true` to receive Server-Sent Events. Intermediate prose can be streamed while ChatGPT continues an internal turn. The stream ends with a final completion chunk and `data: [DONE]`.

Malformed request bodies return `400 invalid_request_error`. Failures after validation, such as a ChatGPT timeout or unavailable UI, return `500 server_error` for non-streaming requests or an SSE error event for an open stream. Disconnecting the client cancels queued work and active response polling.

## OpenCode example

Add an OpenAI-compatible provider to the OpenCode configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "chatworks": {
      "name": "ChatWorks",
      "npm": "@ai-sdk/openai-compatible",
      "env": [],
      "models": {
        "chatworks": {
          "name": "ChatWorks",
          "tool_call": true,
          "limit": { "context": 128000, "output": 4096 }
        }
      },
      "options": {
        "apiKey": "local",
        "baseURL": "http://127.0.0.1:32123/v1"
      }
    }
  }
}
```

The OpenCode model selector is `chatworks/chatworks`. The context and output values belong to the OpenCode configuration; ChatWorks does not enforce those limits.

## Operational limits

ChatWorks waits up to 120 seconds for each stable ChatGPT response and polls every 250 milliseconds. A provider turn permits up to 16 internal ChatGPT responses and two malformed-tool repair attempts. These values are implementation defaults rather than CLI options.
