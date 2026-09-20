import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type TodoItem = {
  id: number;
  title: string;
  done: boolean;
};

type TodoFile = {
  nextId: number;
  items: TodoItem[];
};

function emptyTodoFile(): TodoFile {
  return {
    nextId: 1,
    items: [],
  };
}

function isTodoFile(value: unknown): value is TodoFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.nextId !== "number" ||
    !Number.isInteger(candidate.nextId) ||
    candidate.nextId < 1 ||
    !Array.isArray(candidate.items)
  ) {
    return false;
  }

  return candidate.items.every((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return false;
    }

    const todo = item as Record<string, unknown>;
    return (
      typeof todo.id === "number" &&
      Number.isInteger(todo.id) &&
      todo.id > 0 &&
      typeof todo.title === "string" &&
      typeof todo.done === "boolean"
    );
  });
}

export function formatTodos(items: TodoItem[]): string {
  if (items.length === 0) return "No TODO items.";

  const body = items
    .map((item) => `${item.id}. [${item.done ? "x" : " "}] ${item.title}`)
    .join("\n");

  return `\`\`\`todo\n${body}\n\`\`\``;
}

export class TodoStore {
  readonly path: string;

  constructor(directory = ".chatworks") {
    this.path = join(directory, "todos.json");
  }

  async list(): Promise<TodoItem[]> {
    return (await this.read()).items;
  }

  async add(title: string): Promise<void> {
    const state = await this.read();

    state.items.push({
      id: state.nextId++,
      title,
      done: false,
    });

    await this.write(state);
  }

  async edit(id: number, title: string): Promise<void> {
    await this.update(id, (item) => {
      item.title = title;
    });
  }

  async done(id: number): Promise<void> {
    await this.update(id, (item) => {
      item.done = true;
    });
  }

  async reopen(id: number): Promise<void> {
    await this.update(id, (item) => {
      item.done = false;
    });
  }

  async delete(id: number): Promise<void> {
    const state = await this.read();
    const index = state.items.findIndex((item) => item.id === id);

    if (index < 0) {
      throw new Error(`Could not find TODO '${id}'.`);
    }

    state.items.splice(index, 1);
    await this.write(state);
  }

  private async update(
    id: number,
    change: (item: TodoItem) => void,
  ): Promise<void> {
    const state = await this.read();
    const item = state.items.find((candidate) => candidate.id === id);

    if (!item) {
      throw new Error(`Could not find TODO '${id}'.`);
    }

    change(item);
    await this.write(state);
  }

  private async read(): Promise<TodoFile> {
    let contents: string;

    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;

      if (code === "ENOENT") return emptyTodoFile();
      throw error;
    }

    const value = JSON.parse(contents) as unknown;
    if (!isTodoFile(value)) {
      throw new Error(`Invalid ChatWorks TODO file '${this.path}'.`);
    }

    return value;
  }

  private async write(state: TodoFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });

    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
    await rename(temporary, this.path);
  }
}
