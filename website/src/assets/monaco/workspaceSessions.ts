import { createAnalysisSession, type AnalysisSession } from "compiler/lsp/analysisSession";
import type { Statement } from "compiler/ast/ast";

interface CachedWorkspaceSessionEntry {
  source: string;
  workspaceRevision: number;
  session: Promise<AnalysisSession | null>;
}

export interface CachedWorkspaceSessionResolverOptions {
  getAmbientDeclarations(): Promise<Statement[]>;
  getWorkspaceFileSource(uri: string): string | null;
  getWorkspaceRevision(): number;
  isRuntimeDeclarationPath?(filePath: string): boolean;
  pathToUri(filePath: string): string;
}

export function createCachedWorkspaceSessionResolver(
  options: CachedWorkspaceSessionResolverOptions
): (filePath: string) => Promise<AnalysisSession | null> {
  const cache = new Map<string, CachedWorkspaceSessionEntry>();

  return async (filePath: string): Promise<AnalysisSession | null> => {
    const uri = options.pathToUri(filePath);
    const source = options.getWorkspaceFileSource(uri);
    if (source === null) {
      return null;
    }

    const workspaceRevision = options.getWorkspaceRevision();
    const cached = cache.get(filePath);
    if (
      cached &&
      cached.source === source &&
      cached.workspaceRevision === workspaceRevision
    ) {
      return cached.session;
    }

    const session = (async () => {
      if (options.isRuntimeDeclarationPath?.(filePath)) {
        return createAnalysisSession(source);
      }

      return createAnalysisSession(source, {
        ambientDeclarations: await options.getAmbientDeclarations()
      });
    })();

    cache.set(filePath, {
      source,
      workspaceRevision,
      session,
    });

    session.catch(() => {
      const current = cache.get(filePath);
      if (current?.session === session) {
        cache.delete(filePath);
      }
    });

    return session;
  };
}
