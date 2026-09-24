import type { OpenAICompletion } from "./provider.ts";
import type {
  ProviderChatMessage,
  ProviderRequest,
} from "./provider-request.ts";
import type { ProviderTool } from "./provider-tools.ts";

type UnknownRecord = Record<string, unknown>;

export type DecodedResponsesRequest = {
  request: ProviderRequest;
  stream: boolean;
};

export type ResponsesOutputItem =
  | {
      id: string;
      type: "message";
      status: "completed";
      role: "assistant";
      content: Array<{
        type: "output_text";
        text: string;
        annotations: [];
      }>;
    }
  | {
      id: string;
      type: "function_call";
      status: "completed";
      call_id: string;
      name: string;
      arguments: string;
    };

export type OpenAIResponse = {
  id: string;
  object: "response";
  created_at: number;
  status: "in_progress" | "completed";
  error: null;
  incomplete_details: null;
  model: string;
  output: ResponsesOutputItem[];
  parallel_tool_calls: boolean;
  tool_choice: "auto";
  tools: [];
  usage: {
    input_tokens: number;
    input_tokens_details: { cached_tokens: number };
    output_tokens: number;
    output_tokens_details: { reasoning_tokens: number };
    total_tokens: number;
  };
};

type ResponsesEvent = UnknownRecord & {
  type: string;
  sequence_number: number;
};

export class ResponsesEventStream {
  readonly #emit: (event: ResponsesEvent) => void;
  readonly #id: string;
  readonly #createdAt: number;
  readonly #model: string;
  readonly #output: ResponsesOutputItem[] = [];
  #sequenceNumber = 0;

  constructor(
    model: string,
    id: string,
    emit: (event: ResponsesEvent) => void,
    createdAt = Math.floor(Date.now() / 1_000),
  ) {
    this.#model = model;
    this.#id = id;
    this.#emit = emit;
    this.#createdAt = createdAt;
  }

  start(): void {
    this.#write({
      type: "response.created",
      response: this.#response("in_progress"),
    });
    this.#write({
      type: "response.in_progress",
      response: this.#response("in_progress"),
    });
  }

  writeText(text: string): void {
    const index = this.#output.length;
    const item = textOutputItem(this.#id, index, text);
    const pendingItem = {
      ...item,
      status: "in_progress" as const,
      content: [],
    };
    const part = item.content[0];
    const emptyPart = { ...part, text: "" };

    this.#write({
      type: "response.output_item.added",
      output_index: index,
      item: pendingItem,
    });
    this.#write({
      type: "response.content_part.added",
      item_id: item.id,
      output_index: index,
      content_index: 0,
      part: emptyPart,
    });
    this.#write({
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: index,
      content_index: 0,
      delta: text,
    });
    this.#write({
      type: "response.output_text.done",
      item_id: item.id,
      output_index: index,
      content_index: 0,
      text,
    });
    this.#write({
      type: "response.content_part.done",
      item_id: item.id,
      output_index: index,
      content_index: 0,
      part,
    });
    this.#write({
      type: "response.output_item.done",
      output_index: index,
      item,
    });
    this.#output.push(item);
  }

  complete(completion: OpenAICompletion): void {
    const completionId = this.#id.startsWith("resp_")
      ? "chatcmpl_" + this.#id.slice("resp_".length)
      : "chatcmpl_" + this.#id;
    const normalized = { ...completion, id: completionId };
    for (const item of completionOutputItems(normalized, this.#output.length)) {
      if (item.type === "message") this.#writeTextItem(item);
      else this.#writeFunctionItem(item);
      this.#output.push(item);
    }
    this.#write({
      type: "response.completed",
      response: this.#response("completed"),
    });
  }

  error(message: string): void {
    this.#write({
      type: "error",
      code: "server_error",
      message,
      param: null,
    });
  }

  #writeTextItem(
    item: Extract<ResponsesOutputItem, { type: "message" }>,
  ): void {
    const index = this.#output.length;
    const text = item.content[0].text;
    const pendingItem = {
      ...item,
      status: "in_progress" as const,
      content: [],
    };
    const part = item.content[0];

    this.#write({
      type: "response.output_item.added",
      output_index: index,
      item: pendingItem,
    });
    this.#write({
      type: "response.content_part.added",
      item_id: item.id,
      output_index: index,
      content_index: 0,
      part: { ...part, text: "" },
    });
    this.#write({
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: index,
      content_index: 0,
      delta: text,
    });
    this.#write({
      type: "response.output_text.done",
      item_id: item.id,
      output_index: index,
      content_index: 0,
      text,
    });
    this.#write({
      type: "response.content_part.done",
      item_id: item.id,
      output_index: index,
      content_index: 0,
      part,
    });
    this.#write({
      type: "response.output_item.done",
      output_index: index,
      item,
    });
  }

  #writeFunctionItem(
    item: Extract<ResponsesOutputItem, { type: "function_call" }>,
  ): void {
    const index = this.#output.length;
    const pendingItem = {
      ...item,
      status: "in_progress" as const,
      arguments: "",
    };

    this.#write({
      type: "response.output_item.added",
      output_index: index,
      item: pendingItem,
    });
    this.#write({
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: index,
      delta: item.arguments,
    });
    this.#write({
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: index,
      arguments: item.arguments,
    });
    this.#write({
      type: "response.output_item.done",
      output_index: index,
      item,
    });
  }

  #response(status: "in_progress" | "completed"): OpenAIResponse {
    return {
      id: this.#id,
      object: "response",
      created_at: this.#createdAt,
      status,
      error: null,
      incomplete_details: null,
      model: this.#model,
      output: [...this.#output],
      parallel_tool_calls: true,
      tool_choice: "auto",
      tools: [],
      usage: {
        input_tokens: 0,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 0,
      },
    };
  }

  #write(event: UnknownRecord & { type: string }): void {
    this.#emit({ ...event, sequence_number: this.#sequenceNumber });
    this.#sequenceNumber += 1;
  }
}

export function decodeResponsesRequest(
  value: unknown,
): DecodedResponsesRequest {
  const body = record(value, "Responses request");
  const model = string(body.model, "Responses request model");
  const stream =
    optionalBoolean(body.stream, "Responses request stream") ?? false;
  const messages: ProviderChatMessage[] = [];

  if (body.instructions !== undefined && body.instructions !== null) {
    messages.push({
      role: "developer",
      text: string(body.instructions, "Responses request instructions"),
    });
  }

  if (typeof body.input === "string") {
    messages.push({ role: "user", text: body.input });
  } else {
    array(body.input, "Responses request input").forEach((item, index) => {
      decodeInputItem(item, index, messages);
    });
  }

  if (messages.length === 0) {
    throw new Error("Responses request must contain at least one input item.");
  }

  return {
    stream,
    request: {
      model,
      messages,
      tools:
        body.tools === undefined
          ? []
          : array(body.tools, "Responses request tools").map(decodeTool),
    },
  };
}

function decodeInputItem(
  value: unknown,
  index: number,
  messages: ProviderChatMessage[],
): void {
  const item = record(value, `Responses input item ${index + 1}`);
  switch (item.type) {
    case "message": {
      const role = item.role;
      if (
        role !== "system" &&
        role !== "developer" &&
        role !== "user" &&
        role !== "assistant"
      ) {
        throw new Error(
          `Responses input item ${index + 1} has an unsupported message role.`,
        );
      }
      messages.push({
        role,
        text: decodeItemContent(
          item.content,
          `Responses input item ${index + 1}`,
        ),
      });
      return;
    }

    case "function_call":
      // The assistant call is a conversation boundary. Its arguments were
      // already seen by the client and do not need to be repeated to Classic.
      messages.push({ role: "assistant", text: "" });
      return;

    case "function_call_output":
      messages.push({
        role: "tool",
        text: decodeFunctionOutput(
          item.output,
          `Responses input item ${index + 1} output`,
        ),
        toolCallId: string(
          item.call_id,
          `Responses input item ${index + 1} call_id`,
        ),
      });
      return;

    case "reasoning":
      return;

    default:
      throw new Error(
        `Responses input item ${index + 1} has unsupported type '${String(item.type)}'.`,
      );
  }
}

function decodeItemContent(value: unknown, label: string): string {
  if (typeof value === "string") return value;
  return array(value, `${label} content`)
    .map((candidate, index) => {
      const part = record(candidate, `${label} content part ${index + 1}`);
      if (
        part.type !== "input_text" &&
        part.type !== "output_text" &&
        part.type !== "text"
      ) {
        throw new Error(
          `${label} content part ${index + 1} has unsupported type '${String(part.type)}'.`,
        );
      }
      return string(part.text, `${label} content part ${index + 1} text`);
    })
    .join("");
}

function decodeFunctionOutput(value: unknown, label: string): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return decodeItemContent(value, label);
  return JSON.stringify(value) ?? String(value);
}

function decodeTool(value: unknown, index: number): ProviderTool {
  const tool = record(value, `Responses tool ${index + 1}`);
  if (tool.type !== "function") {
    throw new Error(
      `Responses tool ${index + 1} has unsupported type '${String(tool.type)}'. Disable provider-native tools in the Codex ChatWorks profile.`,
    );
  }

  const name = string(tool.name, `Responses tool ${index + 1} name`);
  const description =
    tool.description === undefined
      ? undefined
      : string(tool.description, `Responses tool ${index + 1} description`);
  const parameters =
    tool.parameters === undefined
      ? undefined
      : record(tool.parameters, `Responses tool ${index + 1} parameters`);
  const required = parameters?.required;
  if (
    required !== undefined &&
    (!Array.isArray(required) ||
      required.some((field) => typeof field !== "string"))
  ) {
    throw new Error(
      `Responses tool ${index + 1} parameters.required must be a string array.`,
    );
  }

  return {
    name,
    ...(description ? { description } : {}),
    ...(parameters
      ? {
          input: {
            ...(Array.isArray(required) ? { required } : {}),
            schema: parameters,
          },
        }
      : {}),
  };
}

export function responseId(completionId: string): string {
  return completionId.replace(/^chatcmpl_/, "resp_");
}

export function completionOutputItems(
  completion: OpenAICompletion,
  startingIndex = 0,
): ResponsesOutputItem[] {
  const choice = completion.choices[0];
  const items: ResponsesOutputItem[] = [];
  let index = startingIndex;

  if (choice.message.content) {
    items.push(
      textOutputItem(responseId(completion.id), index, choice.message.content),
    );
    index += 1;
  }

  for (const call of choice.message.tool_calls ?? []) {
    items.push({
      id: `fc_${call.id}`,
      type: "function_call",
      status: "completed",
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    });
    index += 1;
  }

  return items;
}

export function textOutputItem(
  idSeed: string,
  index: number,
  text: string,
): Extract<ResponsesOutputItem, { type: "message" }> {
  return {
    id: `msg_${idSeed}_${index}`,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

export function responseObject(
  completion: OpenAICompletion,
  output: ResponsesOutputItem[],
  status: "in_progress" | "completed" = "completed",
): OpenAIResponse {
  return {
    id: responseId(completion.id),
    object: "response",
    created_at: completion.created,
    status,
    error: null,
    incomplete_details: null,
    model: completion.model,
    output,
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
    usage: {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    },
  };
}

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as UnknownRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean")
    throw new Error(`${label} must be a boolean.`);
  return value;
}
