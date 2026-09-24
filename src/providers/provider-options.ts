export type ProviderOptions = {
  chat: string;
  port: number;
};

const defaultPort = 32_123;

export function parseProviderOptions(arguments_: string[]): ProviderOptions {
  let chat = "current";
  let chatSpecified = false;
  let port = defaultPort;
  let portSpecified = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    switch (arguments_[index]) {
      case "--chat": {
        if (chatSpecified)
          throw new Error("--chat may be specified only once.");
        const value = arguments_[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error(
            "provider --chat requires an exact title or 'current'.",
          );
        }
        chat = value;
        chatSpecified = true;
        index += 1;
        break;
      }
      case "--port": {
        if (portSpecified)
          throw new Error("--port may be specified only once.");
        const value = arguments_[index + 1];
        const candidate = Number(value);
        if (
          !Number.isInteger(candidate) ||
          candidate < 1 ||
          candidate > 65_535
        ) {
          throw new Error("--port requires an integer from 1 to 65535.");
        }
        port = candidate;
        portSpecified = true;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown provider option: ${arguments_[index]}`);
    }
  }

  return { chat, port };
}
