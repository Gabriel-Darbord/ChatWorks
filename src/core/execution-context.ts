const executionEnvironmentVariable = "CHATWORKS_EXECUTION_ACTIVE";

export class RecursiveExecutionError extends Error {
  constructor() {
    super(
      "Refusing to execute assistant-provided code recursively inside an active ChatWorks execution.",
    );
    this.name = "RecursiveExecutionError";
  }
}

export function isExecutionActive(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment[executionEnvironmentVariable] === "1";
}

export function assertExecutionAllowed(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (isExecutionActive(environment)) {
    throw new RecursiveExecutionError();
  }
}

export function executionEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    [executionEnvironmentVariable]: "1",
  };
}
