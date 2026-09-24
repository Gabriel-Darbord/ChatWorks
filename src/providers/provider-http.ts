import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  completeProviderRequest,
  createProviderState,
  type ClassicProviderGateway,
  type OpenAICompletion,
} from "./provider.ts";
import {
  identityProviderToolAdapter,
  type ProviderToolAdapter,
} from "./provider-tool-adapter.ts";
import { decodeProviderRequest } from "./provider-request.ts";
import { logDebug, logError, logEvent } from "../core/diagnostics.ts";

const maxRequestBytes = 100_000_000;

export function createProviderServer(
  gateway: ClassicProviderGateway,
  toolAdapter: ProviderToolAdapter = identityProviderToolAdapter,
): Server {
  let pending = Promise.resolve();
  let requestCount = 0;
  const providerState = createProviderState();
  const complete = <T>(work: () => Promise<T>): Promise<T> => {
    const result = pending.then(work, work);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return createServer(async (request, response) => {
    const requestId = ++requestCount;
    const startedAt = Date.now();
    try {
      if (request.method === "GET" && request.url === "/v1/models") {
        respondJson(response, 200, {
          object: "list",
          data: [
            {
              id: "chatworks",
              object: "model",
              owned_by: "chatworks",
            },
          ],
        });
        return;
      }

      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        respondJson(response, 404, {
          error: {
            message: "ChatWorks provider route not found.",
            type: "not_found",
          },
        });
        return;
      }

      const correlationId = `provider-${requestId}`;
      const body = await readJson(request);
      await logEvent("provider", "received", {
        correlationId,
        fields: {
          requestBytes: Number(request.headers["content-length"] ?? 0),
        },
      });
      await logDebug("provider", "client-input", {
        correlationId,
        fields: { body: JSON.stringify(body) },
      });
      await logEvent("provider", "queued", { correlationId });
      const streaming = streamRequested(body);
      decodeProviderRequest(body);
      if (streaming) beginStream(response);
      const completion = await complete(async () => {
        await logEvent("provider", "started", {
          correlationId,
          fields: { queueMs: Date.now() - startedAt },
        });
        return completeProviderRequest(
          body,
          gateway,
          correlationId,
          providerState,
          streaming
            ? (text) => writeIntermediateChunk(response, body, text)
            : undefined,
          toolAdapter,
        );
      });
      await logDebug("provider", "client-output", {
        correlationId,
        fields: { completion: JSON.stringify(completion) },
      });
      await logEvent("provider", "completed", {
        correlationId,
        fields: { durationMs: Date.now() - startedAt },
      });
      if (streaming) {
        respondStream(response, completion, false, true);
      } else {
        respondJson(response, 200, completion);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logEvent("provider", "failed", {
        correlationId: `provider-${requestId}`,
        fields: {
          durationMs: Date.now() - startedAt,
          errorName: error instanceof Error ? error.name : "unknown",
          errorMessage: message,
        },
      });
      await logError("provider-request", error);
      if (response.headersSent) {
        writeEvent(response, {
          error: {
            message,
            type: "server_error",
          },
        });
        response.end("data: [DONE]\n\n");
      } else {
        respondJson(response, 400, {
          error: {
            message,
            type: "invalid_request_error",
          },
        });
      }
    }
  });
}

function streamRequested(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Chat completion request must be an object.");
  }
  const stream = (value as Record<string, unknown>).stream;
  if (stream === undefined) return false;
  if (typeof stream !== "boolean") {
    throw new Error("Chat completion request stream must be a boolean.");
  }
  return stream;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxRequestBytes) {
      throw new Error(
        `Chat completion request exceeds ${maxRequestBytes} byte limit.`,
      );
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("Chat completion request body is not valid JSON.");
  }
}

function respondJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function beginStream(response: ServerResponse): void {
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  });
}

function writeIntermediateChunk(
  response: ServerResponse,
  request: unknown,
  content: string,
): void {
  const model =
    typeof request === "object" && request !== null && !Array.isArray(request)
      ? String((request as Record<string, unknown>).model ?? "chatworks")
      : "chatworks";
  writeEvent(response, {
    id: "chatcmpl_chatworks_intermediate",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1_000),
    model,
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content },
        finish_reason: null,
      },
    ],
  });
}

function respondStream(
  response: ServerResponse,
  completion: OpenAICompletion,
  writeHeaders = true,
  writeContent = true,
): void {
  if (writeHeaders) beginStream(response);

  const choice = completion.choices[0];
  if (choice.finish_reason === "tool_calls") {
    if (writeContent && choice.message.content) {
      writeEvent(response, {
        id: completion.id,
        object: "chat.completion.chunk",
        created: completion.created,
        model: completion.model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: choice.message.content },
            finish_reason: null,
          },
        ],
      });
    }
    writeEvent(response, {
      id: completion.id,
      object: "chat.completion.chunk",
      created: completion.created,
      model: completion.model,
      choices: [
        {
          index: 0,
          delta: { tool_calls: choice.message.tool_calls },
          finish_reason: null,
        },
      ],
    });
  } else if (writeContent && choice.message.content) {
    writeEvent(response, {
      id: completion.id,
      object: "chat.completion.chunk",
      created: completion.created,
      model: completion.model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: choice.message.content },
          finish_reason: null,
        },
      ],
    });
  }
  writeEvent(response, {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
    choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }],
  });
  response.end("data: [DONE]\n\n");
}

function writeEvent(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}
