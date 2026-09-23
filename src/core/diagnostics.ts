import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const defaultErrorLog = ".chatworks-probes/errors.jsonl";
const defaultEventLog = ".chatworks-probes/events.jsonl";

export type DiagnosticEvent = {
  timestamp: string;
  source: string;
  event: string;
  correlationId?: string;
  fields?: Record<string, string | number | boolean | null>;
};

export function diagnosticEvent(
  source: string,
  event: string,
  options: {
    correlationId?: string;
    fields?: Record<string, string | number | boolean | null>;
  } = {},
): DiagnosticEvent {
  return {
    timestamp: new Date().toISOString(),
    source,
    event,
    ...(options.correlationId ? { correlationId: options.correlationId } : {}),
    ...(options.fields ? { fields: options.fields } : {}),
  };
}

export function debugLoggingEnabled(): boolean {
  const value = process.env.CHATWORKS_DEBUG?.toLowerCase();
  return value === "1" || value === "true";
}

export async function logDebug(
  source: string,
  event: string,
  options: {
    correlationId?: string;
    fields?: Record<string, string | number | boolean | null>;
  } = {},
): Promise<void> {
  if (!debugLoggingEnabled()) return;
  await logEvent(source, event, options);
}

export async function logEvent(
  source: string,
  event: string,
  options: {
    correlationId?: string;
    fields?: Record<string, string | number | boolean | null>;
  } = {},
): Promise<void> {
  const path = process.env.CHATWORKS_EVENT_LOG ?? defaultEventLog;
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(
      path,
      JSON.stringify(diagnosticEvent(source, event, options)) + "\n",
      "utf8",
    );
  } catch {
    return;
  }
}

export type ErrorDiagnostic = {
  timestamp: string;
  operation: string;
  name?: string;
  message: string;
  stack?: string;
};

export function errorDiagnostic(
  operation: string,
  error: unknown,
): ErrorDiagnostic {
  if (error instanceof Error) {
    return {
      timestamp: new Date().toISOString(),
      operation,
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }

  return {
    timestamp: new Date().toISOString(),
    operation,
    message: String(error),
  };
}

export async function logError(
  operation: string,
  error: unknown,
): Promise<void> {
  const path = process.env.CHATWORKS_ERROR_LOG ?? defaultErrorLog;
  const diagnostic = errorDiagnostic(operation, error);

  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(diagnostic) + "\n", "utf8");
  } catch (loggingError) {
    console.error(
      `chatworks: could not write diagnostic log: ${
        loggingError instanceof Error
          ? loggingError.message
          : String(loggingError)
      }`,
    );
  }
}
