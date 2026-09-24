# CLI and trigger loop

ChatWorks can watch a ChatGPT conversation, execute explicitly enabled code blocks from assistant messages, and submit the resulting output back into the same chat. It can also perform individual read, run, write, chat-navigation, and participant operations.

For the separate OpenAI-compatible server mode, see [Local agent provider](provider.md).

## Requirements

- macOS with ChatGPT Classic or the current ChatGPT desktop application running.
- Node.js 22.6 or later.
- Accessibility permission for the invoking terminal in **System Settings > Privacy & Security > Accessibility**.

## Getting started

Start the continuous trigger loop in the currently displayed chat:

```sh
npm start
```

Process the current assistant response once and exit:

```sh
npm start -- once
```

When both supported ChatGPT applications are running, select one explicitly:

```sh
npm start -- --app classic once
npm start -- --app desktop once
```

## Commands

- `once`: perform one read, execute, and submit cycle, then exit.
- `recover`: print the durable watch transaction, if any.
- `recover discard`: acknowledge recovered work without rerunning its command.
- `recover retry`: retry a failed submission without rerunning its command. This is valid only for a `submission-failed` transaction.
- `read [message]`: print a supplied message, or the current ChatGPT assistant message, together with its parsed blocks.
- `run [message]`: execute supported parts of a supplied message or the current ChatGPT assistant message.
- `write <message>`: stage text in the composer without sending it.
- `send [message]`: send the staged draft, or stage and send the supplied message.
- `chats`: list chats currently exposed by the ChatGPT sidebar.
- `switch <reference>`: select a chat by displayed index or exact title.
- `new`: create a new ChatGPT chat.
- `participant list`: list chats representing ChatWorks participants.
- `participant create <id> <role...>`: create and initialize a participant.
- `discuss <references...>`: relay messages between at least two chats or participants.
- `inspect [label...]`: print matching Accessibility controls as JSON. Labels are optional.
- `provider [--chat <title|current>] [--port <port>]`: start the local agent provider. See [Local agent provider](provider.md).
- `--help`, `-h`: print the command summary.

## Global options

Global options may appear before or after the command.

- `--modules <ids>`: activate comma-separated modules. Available ids are `shell`, `chatworks`, and `discussion`; `none` disables all modules.
- `--app classic|desktop`: target ChatGPT Classic (`com.openai.chat`) or the current desktop app (`com.openai.codex`). Selection is required when both are running and is mandatory for `provider`.
- `--interaction background|focus|pointer`: choose the allowed UI interaction policy. The default is `background`.
- `--as <participant>`: execute `once` or `run` in a participant's execution scope.
- `--checkpoint`: after an executed turn, run repository checks and commit the working tree when appropriate.

`background` avoids activating ChatGPT, moving the pointer, or sending keyboard input when semantic Accessibility operations work. `focus` permits focused keyboard fallback. `pointer` also permits physical pointer fallback. ChatWorks restores focus and pointer state after bridge operations.

## Trigger contract

Messages are parsed into ordered plain-text and fenced-block parts. Active modules visit those parts in order. Unhandled text and blocks remain data and are never executed merely because they appear in a message.

The shell module handles `sh`, `bash`, and `zsh` blocks only when the first line is an explicit ChatWorks directive:

````text
```sh
#!chatworks
pwd
```
````

The directive variants are:

- `#!chatworks`: execute and return the result.
- `#!chatworks silent`: execute without returning a response.
- `#!chatworks skip`: do not execute the block.

At most one modifier is accepted. Unknown or combined modifiers make the directive invalid. Unknown fence languages are not executed. `mcp` is reserved until its request schema is defined.

A normally executed shell block produces response text shaped like this:

````text
```text
pwd
[exit status 0]
<command output>
```
````

Output preserves observed stdout/stderr ordering, and stderr lines are identified in the transcript. Complete shell heredocs may be compacted for presentation without changing the source supplied to the shell.

## Watch mode and recovery

With no command, ChatWorks continuously observes the active chat. Each distinct assistant message is processed once, and any produced result is submitted. Stop the loop with `Ctrl-C` or `SIGTERM`.

Only one production watch instance is allowed. Durable recovery prevents uncertain prior execution from being silently repeated. Use `recover`, `recover discard`, or `recover retry` instead of editing runtime files directly.

## Discussions and participants

`discuss` accepts chat references by displayed sidebar index or exact title. Add `--participants` to interpret every reference as a ChatWorks participant id.

- `--pass` or `--pass=N`: make one or `N` message deliveries.
- `--turn` or `--turn=N`: make one or `N` complete round-robin turns.

Pass and turn modes are mutually exclusive. Counts must be positive integers, selected participant titles must be unique, and a discussion requires at least two participants.
