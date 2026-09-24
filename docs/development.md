# Development and internals

## Development commands

- `npm start`: build the Swift Accessibility bridge and run the TypeScript CLI.
- `npm run bridge:build`: build `chatworks-ax`.
- `npm test`: run TypeScript and Swift tests.
- `npm run test:ts`: run TypeScript tests.
- `npm run test:swift`: run Swift tests.
- `npm run typecheck`: type-check TypeScript without output.
- `npm run format`: format TypeScript and Swift sources.
- `npm run format:check`: verify TypeScript and Swift formatting.
- `npm run check`: run formatting checks, type-checking, all tests, and a final bridge build.

## Architecture boundary

TypeScript owns parsing, execution policy, workflow, persistence, the provider loop, and CLI orchestration. Swift is limited to macOS Accessibility, focus and pointer restoration, clipboard preservation for the direct raw-read command, and the stdin/stdout bridge.

Both ChatGPT applications are supported:

- ChatGPT Classic: `com.openai.chat`
- Current ChatGPT desktop app: `com.openai.codex`

Structured assistant observations are read through Accessibility message parts. Classic uses its dedicated Accessibility reader; the current app uses the shared message-structure reader. UI focus, keyboard input, and pointer movement are compatibility fallbacks governed by the selected interaction policy.

## Direct bridge CLI

The lower-level bridge syntax is:

```text
chatworks-ax [--bundle-id <identifier>] [--interaction background|focus|pointer] <command>
```

Direct commands are `read`, `message-parts`, `assistant-observation`, `assistant-state`, `composer-state`, `scroll-to-bottom`, `stage`, `stage-and-send`, `guarded-stage-and-send`, `send`, `submit-staged-by-send-control`, `submit-staged-unconfirmed`, `list-chats`, `select-chat <reference>`, `rename-chat <reference> <new-title>`, `new-chat`, `inspect-composer`, `inspect-conversation`, `inspect-all`, `inspect-chat-attributes`, `inspect [labels...]`, and `inspect-elements [labels...]`.

`stage`, `stage-and-send`, and `guarded-stage-and-send` read text from standard input. Most bridge commands support the TypeScript orchestrator or Accessibility maintenance; use the top-level `npm start -- ...` interface for normal operation.

## Runtime and diagnostics

- `.chatworks-probes/events.jsonl`: structured lifecycle and optional debug events.
- `.chatworks-probes/errors.jsonl`: persistent errors.
- `.chatworks-probes/watchdog.jsonl`: watchdog observations.
- `.chatworks-runtime/watch-transaction.json`: durable watch transaction.
- `.chatworks-runtime/watch.lock/owner.json`: production watch ownership.
- `.chatworks/`: persistent ChatWorks data such as todo state.

Environment overrides:

- `CHATWORKS_AX_BRIDGE`: bridge executable path.
- `CHATWORKS_DEBUG`: enable debug events when set.
- `CHATWORKS_EVENT_LOG`: event log path.
- `CHATWORKS_ERROR_LOG`: error log path.
- `CHATWORKS_WATCHDOG_LOG`: watchdog log path.

The watch loop polls once per second. Discussion replies use a one-second poll interval, a 120-second timeout, and at most eight unstable observations. Shell execution defaults to a 30-second timeout, a one-second termination grace period, and 64 KiB of captured output.

## Watchdog

Run the read-only watchdog with:

```sh
node --experimental-strip-types scripts/watchdog.ts 60
```

The duration defaults to 60 seconds, must be greater than zero, and may not exceed 3600 seconds. The watchdog samples production watch processes, ownership, assistant observation, and composer state, and warns when multiple production watches are detected.
