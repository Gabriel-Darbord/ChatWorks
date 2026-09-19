import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const defaultErrorLog = ".chatworks-probes/errors.jsonl";

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
