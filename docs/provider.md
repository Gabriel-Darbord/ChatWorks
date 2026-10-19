# Local agent provider

ChatWorks can expose one ChatGPT conversation as a local OpenAI-compatible provider. An agent client sends a model turn to ChatWorks; ChatWorks relays it through the selected ChatGPT UI, translates tool requests into the client's native tool-call format, and returns tool results to the same chat until the turn is complete.

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

## Interaction policy

The global `--interaction` option sets the most intrusive fallback ChatWorks may use. It is a permission ceiling, not a separate provider mode:

- `background` (default): use semantic Accessibility operations only. ChatWorks does not activate ChatGPT, send keyboard events, or move the pointer. An operation fails safely if Accessibility alone cannot perform it.
- `focus`: also permit ChatWorks to activate the selected ChatGPT application and send keyboard input. ChatWorks restores the previously active application and focused element afterward. This is currently required to attach oversized prompts.
- `pointer`: also permit physical pointer fallback when neither Accessibility nor keyboard input works. ChatWorks restores the pointer position afterward. Use this only for controls that require it.

For the default, least intrusive provider:

```sh
npm start -- --app classic --interaction background provider
```

To permit oversized prompts to be attached as text files:

```sh
npm start -- --app classic --interaction focus provider
```

The option may appear before or after `provider`. Selecting `classic` or `desktop` remains independent of the interaction policy; synthetic input is sent only after ChatWorks verifies that the selected application is frontmost.

## Client configuration

Configure an OpenAI-compatible client with:

- Base URL: `http://127.0.0.1:32123/v1`
- Model: `chatworks`
- Tool or function calling: enabled when the client supports it
- Streaming: optional

The provider exposes:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`

The Chat Completions route is useful for OpenAI-compatible clients such as OpenCode. The Responses route is used by the Codex CLI. Both routes share the same ChatWorks turn loop and can be served by the same process.

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

Each user-bearing request refreshes its system and developer instructions and includes one bounded recent user/assistant exchange. Tool-result-only continuations send only the new results because the selected ChatGPT conversation already contains the active turn.

## Tool loop

Client tools are passed through without client-specific rewriting. Their names, descriptions, and JSON input schemas are presented to ChatGPT. The assistant requests operations using one or more ordered `tools` fences, with one JSON object per non-empty line:

````text
```tools
{"name":"read","input":{"filePath":"src/app.ts"}}
{"name":"grep","input":{"pattern":"TODO"}}
```
````

ChatWorks validates the complete batch before returning native tool calls. A malformed batch does not execute a valid prefix. Independent calls should share as few blocks as practical; dependent calls should wait for earlier results.

ChatWorks also adds control tools for catalog discovery and turn completion. Their exact names are included in the prompt. Turn completion is `chatworks` and catalog discovery is `chatworks_listtools`; if either conflicts with a client tool, ChatWorks appends a unique id to both names.

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

## Codex CLI

Codex uses its Responses API transport for custom providers. ChatWorks includes a profile that keeps this setup separate from the regular OpenAI provider:

```toml
model = "chatworks"
model_provider = "chatworks"
model_context_window = 128000
web_search = "disabled"

[agents]
enabled = false

[features]
apps = false
memories = false
multi_agent = false

[mcp_servers.node_repl]
enabled = false

[mcp_servers.headroom]
command = "headroom"
args = ["mcp", "serve"]
enabled = false

[plugins."unified-computer-use@openai-bundled"]
enabled = false

[model_providers.chatworks]
name = "ChatWorks"
base_url = "http://127.0.0.1:32123/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
```

Save this profile at `$CODEX_HOME/chatworks.config.toml` when `$CODEX_HOME` is configured, or at `~/.codex/chatworks.config.toml` otherwise. Start ChatWorks, then run Codex with:

```sh
codex --profile chatworks
```

The profile disables Codex-native web search, apps, memories, subagents, and the configured UI/MCP integrations because those tools are not represented by the local ChatWorks Responses adapter yet. The client tool loop remains available, including shell, file, image, and interactive-input tools exposed by Codex. If your main Codex configuration enables additional plugins or MCP servers, disable them in this profile as well.

## Operational limits

ChatWorks waits up to 120 seconds for each stable ChatGPT response and polls every 250 milliseconds. A provider turn permits up to 16 internal ChatGPT responses and two malformed-tool repair attempts. These values are implementation defaults rather than CLI options.

ChatWorks uses a conservative 64,000 UTF-8 byte threshold after observing Classic reject a 66,676-byte inline message. Larger prompts are sent as a `ChatWorks message.txt` attachment with a short inline instruction. File attachment requires temporary keyboard focus, so start the provider with `--interaction focus` when oversized prompts are possible. ChatWorks activates and verifies the selected application before sending synthetic input, then restores the previous focus and clipboard. `background` mode rejects an oversized prompt before changing the composer.
