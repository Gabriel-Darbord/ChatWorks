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

ChatWorks can also expose a selected ChatGPT conversation as a local OpenAI-compatible provider for OpenCode:

```sh
npm start -- --app classic provider serve --chat "ChatWorks provider"
```

Use `npm start -- --help` for the command summary. See the [documentation index](docs/) for separate user and developer documentation, including the [OpenCode-compatible provider setup](docs/reference.md#opencode-compatible-provider).

For development, run:

```sh
npm run check
```
