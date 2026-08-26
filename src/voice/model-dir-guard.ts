function normalizeResolvedModelDir(uri: string): string {
  return uri.replace(/\/+$/, "");
}

/** Never let legacy cleanup remove the directory selected by current config. */
export function shouldDeleteManagedModelDir(
  candidateDir: string,
  activeModelDir: string
): boolean {
  return normalizeResolvedModelDir(candidateDir) !== normalizeResolvedModelDir(activeModelDir);
}
