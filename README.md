# ChatWorks

ChatWorks interfaces with ChatGPT on macOS through the Accessibility API. It reads assistant messages, executes explicitly supported code blocks, and can write results back to ChatGPT.

Requires Node.js 22.6+ and Accessibility permission for the invoking terminal in **System Settings > Privacy & Security > Accessibility**.

```sh
npm start
npm start -- once
npm start -- read
npm start -- run
npm start -- send "Hello from ChatWorks"
npm start -- chats
npm start -- switch 1
npm start -- new
```

ChatWorks can also expose the current ChatGPT conversation as a local OpenAI-compatible provider for an agent client or IDE. It supports both Chat Completions clients and the Codex Responses transport:

```sh
npm start -- --app classic provider
```

Use `--chat "Exact title"` to select another conversation at startup.

See the [documentation index](docs/) for the [CLI and trigger loop](docs/cli.md), [local agent provider](docs/provider.md), and [development guide](docs/development.md).

For development, run:

```sh
npm run check
```
