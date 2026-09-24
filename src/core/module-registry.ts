import type { MessageModule } from "./modules.ts";

export type ModuleDescriptor = {
  id: string;
  messageModule?: MessageModule;
};

export function activateModules(
  descriptors: ModuleDescriptor[],
  requestedIds?: readonly string[],
): ModuleDescriptor[] {
  const requested =
    requestedIds ?? descriptors.map((descriptor) => descriptor.id);
  if (requested.includes("none")) {
    if (requested.length !== 1)
      throw new Error("'none' cannot be combined with other module ids.");
    return [];
  }

  const available = new Map(
    descriptors.map((descriptor) => [descriptor.id, descriptor]),
  );
  const active: ModuleDescriptor[] = [];
  for (const id of requested) {
    if (active.some((descriptor) => descriptor.id === id))
      throw new Error(`Module '${id}' was selected more than once.`);
    const descriptor = available.get(id);
    if (!descriptor)
      throw new Error(
        `Unknown module '${id}'. Available modules: ${descriptors.map((candidate) => candidate.id).join(", ")}.`,
      );
    active.push(descriptor);
  }
  return active;
}

export function messageModules(active: ModuleDescriptor[]): MessageModule[] {
  return active.flatMap((descriptor) =>
    descriptor.messageModule ? [descriptor.messageModule] : [],
  );
}
