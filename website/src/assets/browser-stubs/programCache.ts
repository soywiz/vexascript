import type { Program } from "compiler/ast/ast";

export async function loadCachedProgram(_cacheKey: string): Promise<Program | null> {
  return null;
}

export async function storeCachedProgram(_cacheKey: string, _program: Program): Promise<void> {
  // Browser website embeds keep runtime declarations in memory instead of writing a process cache.
}
