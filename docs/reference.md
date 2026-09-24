# ChatWorks reference

## User reference

### Requirements

ChatWorks requires Node.js 22.6 or later and Accessibility permission for the invoking terminal in **System Settings > Privacy & Security > Accessibility**.

### Command line

`npm start` builds the Accessibility bridge and starts the continuous watch loop. `npm start -- <command>` invokes a command instead.

#### Commands

- `once`: perform one read, execute, and submit cycle, then exit.
- `recover`: print the durable watch transaction, if any.
- `recover discard`: acknowledge recovered work without rerunning it.
- `recover retry`: rearm a failed submission without rerunning its command. Only valid for a `submission-failed` transaction.
- `read [message]`: print the raw message and its parsed blocks. Without a message, reads ChatGPT.
- `run [message]`: execute supported parts of a supplied message or the current ChatGPT assistant message.
- `write <message>`: stage text in the composer without sending it.
- `send [message]`: send the current staged draft, or stage and send the supplied message.
- `chats`: list chats currently exposed by the ChatGPT sidebar.
- `switch <reference>`: select a chat by displayed index or exact title.
- `new`: create a new ChatGPT chat.
- `participant list`: list chats representing ChatWorks participants.
- `participant create <id> <role...>`: create and initialize a participant.
- `provider serve --chat <title|current> [--port <port>]`: expose one chat through the local OpenCode-compatible provider. Requires `--app`.
- `inspect [label...]`: print matching Accessibility controls as JSON. Labels are optional.
- `discuss <references...>`: relay messages between at least two chats or participants.
- `--help`, `-h`: print the CLI command summary.

#### Global options

Global options may appear with the command arguments.

- `--modules <ids>`: comma-separated active module ids. Available ids are `shell`, `chatworks`, and `discussion`; `none` disables modules. Unknown or incompatible selections are rejected.
- `--app classic|desktop`: explicitly target ChatGPT Classic (`com.openai.chat`) or the newer desktop app (`com.openai.codex`). Selection is required when both applications are running and is mandatory for `provider serve`.
- `--interaction background|focus|pointer`: Accessibility interaction policy. Default: `background`. `focus` permits focused keyboard fallback. `pointer` additionally permits physical pointer fallback. ChatWorks restores focus and pointer state after bridge operations.
- `--as <participant>`: execute `once` or `run` in the named participant's execution scope. It is rejected for other commands.
- `--checkpoint`: after an executed turn, run the repository checks and commit the complete working tree when appropriate. Without this option ChatWorks never commits automatically.

Each of `--modules`, `--as`, `--app`, and `--checkpoint` may be specified only once. `--interaction` accepts only the three policies above.

### Discussions

`discuss` accepts either chat references or participant ids. Add `--participants` to interpret all references as ChatWorks participant ids.

- `--pass`: one message delivery, equivalent to the default.
- `--pass=N`: make `N` deliveries. `N` must be a positive integer.
- `--turn`: one complete round-robin turn.
- `--turn=N`: `N` complete round-robin turns. `N` must be a positive integer.
- `--pass` and `--turn` are mutually exclusive and each may be specified only once.

Chat references may be displayed sidebar indexes or exact titles. Routing resolves them to titles, and selected participant titles must be unique. A discussion requires at least two participants.

### Modules and message execution

Messages are parsed into ordered plain-text and fenced-block parts. Modules visit those parts in order. Unhandled parts remain data and are not executed.

The shell module handles `sh`, `bash`, and `zsh` fences. Commands execute using the declared shell with `-c`; they do not load login-shell configuration. Shell blocks must begin with the `#!chatworks` directive to execute. `#!chatworks` uses normal execution, `#!chatworks silent` executes without returning a response, and `#!chatworks skip` does not execute the block. At most one modifier is accepted; unknown or combined modifiers make the directive invalid.

Unknown fence languages are not executed. `mcp` is reserved until its request schema is defined.

#### Block contract

A shell block such as:

````text
```sh
#!chatworks
pwd
```
````

produces response text of the form:

````text
```text
pwd
[exit status 0]
<command output>
```
````

Output preserves observed stdout/stderr ordering; stderr lines are identified in the returned transcript. Complete shell heredocs may be compacted for presentation without changing the source supplied to the shell.

### Watch mode and recovery

With no command, ChatWorks continuously observes the active chat. Each distinct assistant message is processed once and any produced result is submitted. Stop it with `Ctrl-C` or `SIGTERM`.

Only one production watch instance is allowed. Durable recovery prevents uncertain prior execution from being silently rerun. Use the `recover` commands to inspect and resolve recoverable state rather than manipulating runtime files directly.

### OpenCode-compatible provider

ChatWorks can expose a selected ChatGPT conversation through a local OpenAI-compatible endpoint for use as an OpenCode provider.

Start it by explicitly selecting the ChatGPT application:

```sh
npm start -- --app classic provider serve --chat "ChatWorks provider"
npm start -- --app desktop provider serve --chat "ChatWorks provider"
```

`--chat` is required and may be specified only once. `--chat current` binds the currently displayed conversation without sidebar navigation. A named chat is selected once at startup.

`--port <number>` selects the loopback port. The default is `32123`; valid values are `1` through `65535`. The server binds only to `127.0.0.1` and exposes the `/v1` OpenAI-compatible endpoint.

A minimal OpenCode provider configuration is:

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

The model id is `chatworks/chatworks`. The context and output values above configure OpenCode; they are not limits enforced by ChatWorks.

#### Provider tool protocol

An assistant requests OpenCode operations using one or more ordered `tools` fences. Each non-empty line contains one JSON object with `name` and `input` fields:

````text
```tools
{"name":"read","input":{"filePath":"src/app.ts"}}
{"name":"grep","input":{"pattern":"TODO"}}
```
````

ChatWorks validates every `tools` block in the response as one complete batch before returning tool calls. A malformed batch does not execute a valid prefix. Independent calls should share as few blocks as practical; dependent calls should be sequenced across turns.

ChatWorks adds namespaced control tools for catalog discovery and turn completion. Their exact names are included in the prompt. The default namespace is `chatworks_internal`; when a client tool already uses either generated name, ChatWorks selects the next free numbered namespace for both control tools.

### Environment variables

- `CHATWORKS_AX_BRIDGE`: override the path to the `chatworks-ax` executable.
- `CHATWORKS_DEBUG`: enable debug event logging. Unset disables debug events.
- `CHATWORKS_EVENT_LOG`: override the event JSONL path.
- `CHATWORKS_ERROR_LOG`: override the error JSONL path.
- `CHATWORKS_WATCHDOG_LOG`: override watchdog output.

## Developer reference

This section describes development, diagnostics, and implementation details. Values described here are not user configuration unless the user reference explicitly exposes them as a command-line option or environment variable.

### Development commands

- `npm start`: build the Swift bridge and run the TypeScript CLI.
- `npm run bridge:build`: build `chatworks-ax`.
- `npm test`: run TypeScript and Swift tests.
- `npm run test:ts`: run TypeScript tests.
- `npm run test:swift`: run Swift tests.
- `npm run typecheck`: TypeScript type checking without output.
- `npm run format`: format TypeScript and Swift.
- `npm run format:ts`: format TypeScript source/tests with Prettier.
- `npm run format:swift`: format Swift sources.
- `npm run format:check`: verify TypeScript and Swift formatting.
- `npm run format:check:ts`: verify TypeScript formatting.
- `npm run format:check:swift`: strictly lint Swift formatting.
- `npm run check`: formatting checks, TypeScript typecheck, all tests, and a final bridge build.

### Accessibility behavior

The default `background` interaction policy avoids activating ChatGPT, pointer movement, and keyboard input when semantic Accessibility operations suffice. `focus` and `pointer` deliberately widen the allowed fallback mechanisms.

The reader obtains assistant source through the Copy control and restores the clipboard afterward. Rendered Accessibility text is not treated as executable assistant source.

`inspect` and the direct bridge inspection commands are maintenance interfaces for diagnosing ChatGPT UI changes; they are read-only unless the command name itself explicitly describes an interaction.

### Direct bridge CLI

`chatworks-ax` is the lower-level Swift bridge. Its connection syntax is:

```text
chatworks-ax [--bundle-id <identifier>] [--interaction background|focus|pointer] <command>
```

`--bundle-id` directly selects an application bundle id. `--interaction` defaults to `background` and accepts the same policies as the TypeScript CLI.

Direct bridge commands are: `read`, `message-parts`, `assistant-observation`, `assistant-state`, `composer-state`, `scroll-to-bottom`, `stage`, `stage-and-send`, `guarded-stage-and-send`, `send`, `submit-staged-by-send-control`, `submit-staged-unconfirmed`, `list-chats`, `select-chat <reference>`, `rename-chat <reference> <new-title>`, `new-chat`, `inspect-composer`, `inspect-conversation`, `inspect-all`, `inspect-chat-attributes`, `inspect [labels...]`, and `inspect-elements [labels...]`.

`stage`, `stage-and-send`, and `guarded-stage-and-send` read their text from standard input. Most bridge commands exist to support the TypeScript orchestrator or Accessibility maintenance; the top-level `npm start -- ...` interface should normally be preferred.

### Runtime and diagnostics

Implementation-defined state is stored under these paths:

- `.chatworks-probes/events.jsonl`: default debug event log.
- `.chatworks-probes/errors.jsonl`: default error log.
- `.chatworks-probes/watchdog.jsonl`: default watchdog log.
- `.chatworks-runtime/watch-transaction.json`: durable watch transaction.
- `.chatworks-runtime/watch.lock/owner.json`: production watch ownership record.
- `.chatworks/`: default persistent directory used by ChatWorks todo state.

Diagnostic and runtime directories are created as needed. The probe log paths can be overridden through the environment variables documented in the user reference; the runtime state paths are implementation details.

The watch loop currently polls once per second. Durable transactions distinguish `executing`, `pending`, `submission-failed`, and `acknowledged` phases.

Discussion reply polling currently uses internal defaults of one second between observations, a 120-second response timeout, and at most eight unstable reply observations. These are library options, not CLI settings.

Shell execution currently uses internal defaults of a 30-second timeout, a one-second termination grace period, and a 64 KiB captured-output limit. These are module API options, not CLI settings.

Provider response polling currently uses an internal 250 ms interval and a 120-second timeout. These are gateway API options, not provider CLI settings.

### Watchdog

Run the read-only watchdog directly with Node's TypeScript support:

```sh
node --experimental-strip-types scripts/watchdog.ts 60
```

Its positional argument is the observation duration in seconds. It defaults to `60`, must be finite and greater than zero, and may not exceed `3600`. The watchdog samples production watch processes, watch ownership, assistant observation, and composer state, and warns when multiple production watches are detected.

The watchdog honors `CHATWORKS_AX_BRIDGE` and `CHATWORKS_WATCHDOG_LOG`.
