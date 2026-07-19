export async function ambientDeclarationsForProject(_sourcePath: string, _project: unknown): Promise<any[]> {
  return [];
}

export async function globalDeclarationsForProject(_project: unknown): Promise<any[]> {
  return [];
}

export async function ensureRuntimeDependencies(_sourcePath: string, _project: unknown): Promise<void> {
}

export async function vexaTypeCheckForSource(
  sourcePath: string,
  _project: unknown,
  semanticCheck: boolean
): Promise<boolean> {
  if (!semanticCheck) return false;
  const lowerPath = sourcePath.toLowerCase();
  return !(lowerPath.endsWith(".ts") || lowerPath.endsWith(".tsx"));
}

export async function createBundledModuleArtifacts(
  _sourcePath: string,
  _target: unknown,
  _project: unknown,
  _jsxOptions: unknown,
  _options?: unknown
): Promise<any> {
  throw new Error("JavaScript bundling is not available in the native VexaScript CLI yet");
}

export async function resolveServeBundleInput(_rootDir: string, _explicitBundleInput?: string): Promise<string> {
  throw new Error("The development server is not available in the native VexaScript CLI yet");
}
