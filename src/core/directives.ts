export type ChatWorksDirective = {
  source: string;
  mode: "normal" | "silent" | "skip";
};

const chatWorksShebang = "#!chatworks";

export function chatWorksDirective(
  source: string,
): ChatWorksDirective | undefined {
  const newline = source.search(/\r?\n/);
  const firstLine = newline === -1 ? source : source.slice(0, newline);

  const directive = firstLine.trim().split(/\s+/);
  if (directive[0] !== chatWorksShebang) {
    return undefined;
  }

  const modifiers = directive.slice(1);
  if (
    modifiers.length > 1 ||
    (modifiers.length === 1 &&
      modifiers[0] !== "silent" &&
      modifiers[0] !== "skip")
  ) {
    return undefined;
  }

  const mode: ChatWorksDirective["mode"] =
    modifiers[0] === "silent"
      ? "silent"
      : modifiers[0] === "skip"
        ? "skip"
        : "normal";

  if (newline === -1) {
    return { source: "", mode };
  }

  const lineBreakLength = source[newline] === "\r" ? 2 : 1;
  return {
    source: source.slice(newline + lineBreakLength),
    mode,
  };
}
