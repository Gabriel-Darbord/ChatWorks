export type OpenCodeServeOptions = {
  chat: string;
  port: number;
};

const defaultPort = 32_123;

export function parseOpenCodeServeOptions(
  arguments_: string[],
): OpenCodeServeOptions {
  let chat: string | undefined;
  let port = defaultPort;

  for (let index = 0; index < arguments_.length; index += 1) {
    switch (arguments_[index]) {
      case "--chat": {
        if (chat !== undefined)
          throw new Error("--chat may be specified only once.");
        const value = arguments_[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("provider serve requires --chat <exact title>.");
        }
        chat = value;
        index += 1;
        break;
      }
      case "--port": {
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
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown provider serve option: ${arguments_[index]}`);
    }
  }

  if (!chat) throw new Error("provider serve requires --chat <exact title>.");
  return { chat, port };
}
