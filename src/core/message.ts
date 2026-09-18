export type PlainText = {
  kind: "plain-text";
  text: string;
};

export type Block = {
  kind: "block";
  language: string;
  metadata?: string;
  source: string;
};

export type MessagePart = PlainText | Block;

export type Message = {
  raw: string;
  parts: MessagePart[];
};

export function parseMessage(markdown: string): Message {
  const parts: MessagePart[] = [];
  const plain: string[] = [];
  const lines = markdown.split(/\r?\n/);
  let active: { length: number; language: string; metadata?: string; opening: string; source: string[] } | undefined;

  const addPlain = (lines: string[]) => {
    if (lines.length === 0) return;
    const text = lines.join("\n");
    const previous = parts.at(-1);
    if (previous?.kind === "plain-text") previous.text += "\n" + text;
    else parts.push({ kind: "plain-text", text });
  };

  for (const line of lines) {
    if (!active) {
      const opening = line.match(/^(`{3,})[ \t]*([^\s`]+)(?:[ \t]+(.*?))?[ \t]*$/);
      if (!opening) {
        plain.push(line);
        continue;
      }
      addPlain(plain);
      plain.length = 0;
      active = {
        length: opening[1].length,
        language: opening[2].toLowerCase(),
        metadata: opening[3] || undefined,
        opening: line,
        source: [],
      };
      continue;
    }

    if (new RegExp("^`{" + active.length + ",}\\s*$").test(line)) {
      parts.push({
        kind: "block",
        language: active.language,
        ...(active.metadata ? { metadata: active.metadata } : {}),
        source: active.source.join("\n"),
      });
      active = undefined;
    } else {
      active.source.push(line);
    }
  }

  if (active) plain.push(active.opening, ...active.source);
  addPlain(plain);
  return { raw: markdown, parts };
}
