export interface RuntimeDeclarationSource {
  filePath: string;
  source: string;
}

export interface RuntimeDeclarationsHost {
  loadDomDeclarations(): Promise<RuntimeDeclarationSource>;
}

let runtimeDeclarationsHost: RuntimeDeclarationsHost | null = null;

export function setRuntimeDeclarationsHost(host: RuntimeDeclarationsHost): void {
  runtimeDeclarationsHost = host;
}

export function patchRuntimeDeclarationsHost(
  host: Partial<RuntimeDeclarationsHost>
): void {
  runtimeDeclarationsHost = {
    loadDomDeclarations:
      host.loadDomDeclarations ??
      runtimeDeclarationsHost?.loadDomDeclarations ??
      missingDomDeclarations
  };
}

export function getRuntimeDeclarationsHost(): RuntimeDeclarationsHost {
  if (!runtimeDeclarationsHost) {
    throw new Error("Runtime declarations host has not been configured");
  }
  return runtimeDeclarationsHost;
}

async function missingDomDeclarations(): Promise<RuntimeDeclarationSource> {
  throw new Error("DOM runtime declarations host is not configured");
}
