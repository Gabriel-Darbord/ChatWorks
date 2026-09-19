export function hasShellDirective(source: string): boolean {
  const firstLine = source.split(/\r?\n/, 1)[0];
  return firstLine.trim() === "# chatworks:shell";
}
