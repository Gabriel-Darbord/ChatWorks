import type { ProviderTool } from "./provider-tools.ts";

type InputFieldTransformation = {
  source: string;
  target: string;
  description?: string;
};

type ToolTransformation = {
  description?: string;
  inputFields?: InputFieldTransformation[];
};

const taskDescription = `Continue a complex, multistep task autonomously. Use this tool when additional focused iteration is useful before you can complete the user's request.

When using the Task tool, specify a mode appropriate to the work.

When NOT to use the Task tool:
- If you want to read a specific file path, use the Read or Glob tool instead
- If you are searching for a specific class definition, use the Grep tool instead
- If you are searching within a specific file or a small known set of files, use the Read tool instead
- If no available mode fits the work, use other tools directly

Usage notes:
1. Use multiple independent Task calls in one response when parallel investigation would be useful.
2. Do not repeat work already covered by an active Task call; continue with non-overlapping work or wait for its result.
3. A completed Task call returns a result for you to use in continuing the user's request. Its task_id can be supplied later to continue the same task context.
4. Without task_id, each invocation starts with a fresh task context. Give it sufficiently complete instructions and state what result is needed.
5. Treat returned findings as working results, but verify them when correctness requires it.
6. State whether the iteration should modify code or only investigate, and include relevant verification requirements.
7. Use the tool proactively when an additional autonomous iteration would materially help complete the request.

Available modes:
- explore: Fast codebase exploration for locating files, searching symbols or patterns, and understanding project structure. State the desired thoroughness: quick, medium, or very thorough.
- general: General-purpose iteration for complex research, implementation, and multistep work.`;

const transformations: Record<string, ToolTransformation> = {
  task: {
    description: taskDescription,
    inputFields: [
      {
        source: "subagent_type",
        target: "mode",
        description: "The mode to use for this autonomous iteration",
      },
    ],
  },
};

export function presentOpenCodeTool(tool: ProviderTool): ProviderTool {
  const transformation = transformations[tool.name];
  if (!transformation) return tool;

  return (transformation.inputFields ?? []).reduce(
    (presented, field) => renameInputField(presented, field),
    transformation.description
      ? { ...tool, description: transformation.description }
      : tool,
  );
}

export function restoreOpenCodeToolInput(
  name: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const transformation = transformations[name];
  if (!transformation) return input;

  return (transformation.inputFields ?? []).reduce(
    (restored, field) =>
      renameRecordField(restored, field.target, field.source),
    input,
  );
}

function renameInputField(
  tool: ProviderTool,
  transformation: InputFieldTransformation,
): ProviderTool {
  const { source, target, description } = transformation;
  const schema = tool.input?.schema;
  if (!schema) return tool;

  const properties = schema.properties;
  const presentedProperties =
    properties && typeof properties === "object" && !Array.isArray(properties)
      ? { ...(properties as Record<string, unknown>) }
      : undefined;

  if (presentedProperties && source in presentedProperties) {
    const property = presentedProperties[source];
    delete presentedProperties[source];
    presentedProperties[target] =
      property && typeof property === "object" && !Array.isArray(property)
        ? {
            ...(property as Record<string, unknown>),
            ...(description ? { description } : {}),
          }
        : property;
  }

  const required = Array.isArray(schema.required)
    ? schema.required.map((field) => (field === source ? target : field))
    : undefined;

  return {
    ...tool,
    description,
    input: {
      ...tool.input,
      ...(required ? { required } : {}),
      schema: {
        ...schema,
        ...(presentedProperties ? { properties: presentedProperties } : {}),
        ...(required ? { required } : {}),
      },
    },
  };
}

export const openCodeToolAdapter = {
  present: presentOpenCodeTool,
  restoreInput: restoreOpenCodeToolInput,
};

function renameRecordField(
  input: Record<string, unknown>,
  source: string,
  target: string,
): Record<string, unknown> {
  if (!(source in input)) return input;
  const restored = { ...input, [target]: input[source] };
  delete restored[source];
  return restored;
}
