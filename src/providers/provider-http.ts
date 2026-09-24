import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import {
  completeDecodedProviderRequest,
  createProviderState,
  type ClassicProviderGateway,
  type OpenAICompletion,
} from "./provider.ts";
import { decodeProviderRequest } from "./provider-request.ts";
import {
  completionOutputItems,
  decodeResponsesRequest,
  responseObject,
  ResponsesEventStream,
} from "./responses-api.ts";
import { logDebug, logError, logEvent } from "../core/diagnostics.ts";

const maxRequestBytes = 100_000_000;

export function createProviderServer(gateway: ClassicProviderGateway): Server {
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
    let requestValidated = false;
    let protocol: "chat-completions" | "responses" | undefined;
    let responsesStream: ResponsesEventStream | undefined;
    const cancellation = new AbortController();
    const cancel = () => {
      if (cancellation.signal.aborted) return;
      const error = new Error("Provider request was cancelled by its client.");
      error.name = "AbortError";
      cancellation.abort(error);
    };
    const cancelOnResponseClose = () => {
      if (!response.writableEnded) cancel();
    };
    request.once("aborted", cancel);
    response.once("close", cancelOnResponseClose);

    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/models") {
        respondJson(
          response,
          200,
          url.searchParams.has("client_version")
            ? codexModelCatalog()
            : openAIModelCatalog(),
        );
        return;
      }

      if (
        request.method !== "POST" ||
        (url.pathname !== "/v1/chat/completions" &&
          url.pathname !== "/v1/responses")
      ) {
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
      protocol =
        url.pathname === "/v1/responses" ? "responses" : "chat-completions";
      const decoded =
        protocol === "responses"
          ? decodeResponsesRequest(body)
          : {
              request: decodeProviderRequest(body),
              stream: streamRequested(body),
            };
      const { request: providerRequest, stream: streaming } = decoded;
      requestValidated = true;
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
      if (streaming) {
        beginStream(response);
        if (protocol === "responses") {
          responsesStream = new ResponsesEventStream(
            providerRequest.model,
            `resp_chatworks_${randomUUID().replaceAll("-", "")}`,
            (event) => writeResponsesEvent(response, event),
          );
          responsesStream.start();
        }
      }
      const completion = await complete(async () => {
        cancellation.signal.throwIfAborted();
        await logEvent("provider", "started", {
          correlationId,
          fields: { queueMs: Date.now() - startedAt },
        });
        return completeDecodedProviderRequest(
          providerRequest,
          gateway,
          correlationId,
          providerState,
          streaming
            ? (text) => {
                if (cancellation.signal.aborted) return;
                if (protocol === "responses") responsesStream?.writeText(text);
                else writeIntermediateChunk(response, body, text);
              }
            : undefined,
          cancellation.signal,
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
      if (protocol === "responses") {
        if (streaming) {
          responsesStream?.complete(completion);
          response.end();
        } else {
          respondJson(
            response,
            200,
            responseObject(completion, completionOutputItems(completion)),
          );
        }
      } else if (streaming) {
        respondStream(response, completion);
      } else {
        respondJson(response, 200, completion);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = cancellation.signal.aborted;
      await logEvent("provider", cancelled ? "cancelled" : "failed", {
        correlationId: `provider-${requestId}`,
        fields: {
          durationMs: Date.now() - startedAt,
          errorName: error instanceof Error ? error.name : "unknown",
          errorMessage: message,
        },
      });
      if (!cancelled) await logError("provider-request", error);
      if (response.destroyed || response.writableEnded) return;
      if (cancelled) {
        response.destroy();
        return;
      }
      if (response.headersSent) {
        if (protocol === "responses") {
          responsesStream?.error(message);
          response.end();
        } else {
          writeEvent(response, {
            error: {
              message,
              type: "server_error",
            },
          });
          response.end("data: [DONE]\n\n");
        }
      } else {
        respondJson(response, requestValidated ? 500 : 400, {
          error: {
            message,
            type: requestValidated ? "server_error" : "invalid_request_error",
          },
        });
      }
    } finally {
      request.off("aborted", cancel);
      response.off("close", cancelOnResponseClose);
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
): void {
  const choice = completion.choices[0];
  if (choice.finish_reason === "tool_calls") {
    if (choice.message.content) {
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
  } else if (choice.message.content) {
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

function writeResponsesEvent(
  response: ServerResponse,
  event: { type: string },
): void {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function openAIModelCatalog(): unknown {
  return {
    object: "list",
    data: [
      {
        id: "chatworks",
        object: "model",
        owned_by: "chatworks",
      },
    ],
  };
}

function codexModelCatalog(): unknown {
  return {
    models: [
      {
        slug: "chatworks",
        display_name: "ChatWorks",
        description: "ChatGPT through the local ChatWorks provider.",
        base_instructions: "",
        default_reasoning_level: "medium",
        supported_reasoning_levels: [
          {
            effort: "low",
            description: "Ask ChatGPT to use lighter reasoning.",
          },
          {
            effort: "medium",
            description: "Use the default ChatGPT reasoning level.",
          },
          {
            effort: "high",
            description: "Ask ChatGPT to use deeper reasoning.",
          },
        ],
        shell_type: "unified_exec",
        visibility: "list",
        supported_in_api: true,
        priority: 1,
        include_skills_usage_instructions: false,
        include_plugin_usage_instructions: false,
        include_apps_usage_instructions: false,
        default_reasoning_summary: "none",
        support_verbosity: false,
        truncation_policy: { mode: "tokens", limit: 10_000 },
        context_window: 128_000,
        max_context_window: 128_000,
        effective_context_window_percent: 95,
        input_modalities: ["text"],
        supports_search_tool: false,
        supports_experimental_context: false,
        experimental_supported_tools: [],
        use_responses_lite: false,
      },
    ],
  };
}
