# ChatWorks

A macOS proof of concept for a code-block-driven agent loop in the ChatGPT app. TypeScript owns the protocol and execution logic. Swift is isolated in the `ChatWorksAX` library: its stable surface is only connect, read raw Markdown through Copy, stage text, and send. The tiny `chatworks-ax` executable exposes those operations to TypeScript over stdin/stdout.

With no command, ChatWorks continuously watches the active ChatGPT chat. Each distinct assistant message is read from its Copy control, supported blocks run once, and their results are staged and submitted. Stop it with `Ctrl-C`.

`once` performs that same cycle exactly once and exits; it does not poll for another message.

Automatic and `once` cycles use one native `stage-and-send` operation, so ChatGPT is activated only once per result. Focus and pointer restoration are currently disabled while the interaction behavior is refined.

The individual commands are available for inspection and manual control:

1. `read [message]` prints every parsed fence, either from supplied text or from the newest ChatGPT message when omitted.
2. `run [message]` executes supported blocks from supplied text or the newest ChatGPT message, streaming output to the terminal.
3. `write <message>` stages exactly that message in ChatGPT's input.
4. `send [message]` presses ChatGPT's Send button, or stages and submits the supplied message in one operation.
5. `chats` lists the conversations currently exposed in ChatGPT's sidebar.
6. `switch <reference>` selects a chat by exact name or its displayed index.
7. `new` creates a new ChatGPT chat and selects Chat mode rather than Work mode.

## Message model and modules

TypeScript parses every raw assistant message into ordered `PlainText` and fenced `Block` parts. A block retains its fence language and optional metadata, such as `id="shell-test"` in ```` ```sh id="shell-test" ````. Configured modules visit those parts in order. Parts with no matching module remain data; they are neither executed nor discarded from the model.

Modules are selected independently of the macOS bridge. By default, `shell` and `discussion` are active. Use `--modules shell`, `--modules discussion`, or `--modules none` to select exactly what is active; the registry rejects unknown or incompatible module combinations. The `shell` module handles `sh`, `bash`, and `zsh` blocks. Future modules can handle other block languages or plain-text instructions without changing the macOS bridge.

## Discussions

`discuss` relays an assistant message around two or more ChatGPT chats. Its participant arguments use the same references as `switch`: a displayed index or exact chat title. The first participant's latest assistant message starts the discussion. ChatWorks keeps an in-memory transcript for the invocation and sends each recipient every entry it has not already seen; authors are considered to have seen their own entries. Each delivery carries a compact roster of participant ids, explicit sender labels, and an instruction to contribute for the next participant. A response control must stabilize within eight accessibility observations; only then does ChatWorks copy it once. Otherwise the discussion stops with an error rather than repeatedly copying indefinitely.

```sh
npm start -- discuss 3 7
npm start -- discuss 3 7 1 --pass 5
npm start -- discuss 3 7 1 --turn
npm start -- discuss "Research Codex efficiency" 7 --turn
```

The default makes one pass: chat 3's latest assistant message goes to chat 7 and ChatWorks exits immediately after submission. `--pass` also explicitly selects one pass, while `--pass N` makes N such deliveries; before every delivery after the first, ChatWorks waits for and copies the prior recipient's new assistant reply once. `--turn` makes one full round-robin turn, including the handoff back to the first participant; `--turn N` makes N full rounds. Chat titles must be unique among the selected participants: indexes are only used for the initial snapshot, while subsequent routing uses the title so new messages cannot cause sidebar reordering to select the wrong chat.

## Usage

Grant the invoking terminal Accessibility permission in **System Settings > Privacy & Security > Accessibility**, then:

```sh
npm start
npm start -- once
npm start -- read
npm start -- read $'```sh id="local-test"\necho hello\n```'
npm start -- run
npm start -- run --modules shell
npm start -- run $'```sh\necho hello\n```'
npm start -- write "Hello from ChatWorks"
npm start -- send
npm start -- send "Hello and submit this immediately"
npm start -- chats
npm start -- switch 1
npm start -- switch "Dev contributor 1"
npm start -- new
npm start -- discuss 3 7 --turn
```

Node 22.6 or later runs the TypeScript files directly with native type stripping. The app has no runtime npm dependencies; local TypeScript and Node type definitions are development dependencies used by `npm run typecheck`. `npm start` builds `chatworks-ax`, then starts the TypeScript orchestrator.

## Repository layout

- `Sources/ChatWorksAX/` — the small Swift accessibility and pasteboard library.
- `Sources/ChatWorksBridge/` — the Swift stdin/stdout executable used by TypeScript.
- `src/core/` — message parsing and module dispatch, independent of macOS automation.
- `src/modules/` — configured message handlers, currently the shell handler.
- `src/adapters/` — the TypeScript subprocess adapter for the Swift bridge.
- `test/` — TypeScript unit tests mirroring the source boundaries.

Run `npm run check` to type-check TypeScript, execute its tests, and build the Swift bridge.

`inspect [label...]` is a read-only maintenance tool for ChatGPT UI changes. It prints controls with an exact, case-insensitive matching label as JSON, including role, labels, frame, and available actions. For example, `npm start -- inspect Chat Work` exposes the current mode toggle without using rendered text as an execution source.

The initial `shell` module handles only `sh`, `bash`, and `zsh` blocks. It executes each block with its declared shell and `-c`, without loading login-shell configuration. Blocks use `set -e`; Bash and Zsh blocks also use `set -o pipefail`. They allow 30 seconds and include at most 64 KiB of output in the response. Output is kept in observed stream order; stderr lines are marked with `stderr:`. The Swift bridge activates the running ChatGPT application before performing accessibility work; it recognizes both current `com.openai.codex` and earlier `com.openai.chat` bundle identifiers.

The reader restores the clipboard after every copy. It never uses rendered accessibility text as the execution source.

The `mcp` fence language is intentionally reserved until its request schema is defined. Shell blocks can call a locally installed MCP CLI during this proof of concept.

## Block Contract

An executable assistant block has this form:

````text
```sh
pwd
```
````

Its returned text is formatted for the next conversation turn as:

````text
```text
pwd
[exit status 0]
<command output>
```
````

Unknown fence languages remain data and are never executed. Complete shell heredocs are compacted in returned transcripts to their line count; this only affects presentation, not the source passed to the shell.
