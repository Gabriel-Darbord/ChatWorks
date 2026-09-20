export type ChatWorksDirective = {
  source: string;
};

const chatWorksShebang = "#!chatworks";

export function chatWorksDirective(
  source: string,
): ChatWorksDirective | undefined {
  const newline = source.search(/\r?\n/);
  const firstLine = newline === -1 ? source : source.slice(0, newline);

  if (firstLine.trim() !== chatWorksShebang) {
    return undefined;
  }

  if (newline === -1) {
    return { source: "" };
  }

  const lineBreakLength = source[newline] === "\r" ? 2 : 1;
  return {
    source: source.slice(newline + lineBreakLength),
  };
}
