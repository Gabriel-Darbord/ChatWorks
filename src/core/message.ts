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
  raw?: string;
  parts: MessagePart[];
};

export type AccessibilityMessagePart = {
  kind: "text" | "code";
  text?: string;
  language?: string;
  source?: string;
};

export function messageFromAccessibilityParts(
  parts: AccessibilityMessagePart[],
): Message {
  const messageParts: MessagePart[] = parts.map((part): MessagePart => {
    if (part.kind === "text") {
      if (typeof part.text !== "string") {
        throw new Error("Accessibility text part is missing text.");
      }
      return { kind: "plain-text", text: part.text };
    }

    if (part.kind === "code") {
      if (typeof part.source !== "string") {
        throw new Error("Accessibility code part is missing source.");
      }
      return {
        kind: "block",
        language: part.language?.toLowerCase() ?? "",
        source: part.source,
      };
    }

    throw new Error(
      `Unsupported accessibility message part: ${JSON.stringify(part)}`,
    );
  });

  // AX-backed messages have no canonical Markdown source representation.
  return { parts: messageParts };
}

export function messageText(message: Message): string {
  return message.parts
    .map((part) => {
      if (part.kind === "plain-text") return part.text;

      const language = part.language || "text";
      return `\`\`\`${language}
${part.source}
\`\`\``;
    })
    .join("\n\n");
}

export function messageIdentity(message: Message): string {
  // AX-backed messages have no raw Markdown. Identity is therefore based on
  // the ordered semantic parts shared by both message constructors.
  return JSON.stringify(message.parts);
}

export function parseMessage(markdown: string): Message {
  const parts: MessagePart[] = [];
  const plain: string[] = [];
  const lines = markdown.split(/\r?\n/);
  let active:
    | {
        length: number;
        language: string;
        metadata?: string;
        opening: string;
        source: string[];
      }
    | undefined;

  const addPlain = (lines: string[]) => {
    if (lines.length === 0) return;
    const text = lines.join("\n");
    const previous = parts.at(-1);
    if (previous?.kind === "plain-text") previous.text += "\n" + text;
    else parts.push({ kind: "plain-text", text });
  };

  for (const line of lines) {
    if (!active) {
      const opening = line.match(
        /^(`{3,})[ \t]*([^\s`]+)(?:[ \t]+(.*?))?[ \t]*$/,
      );
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
