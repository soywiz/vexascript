import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat, watch } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { VexaServeMapping } from "../compiler/project";
import type { TranspileDiagnostic, TranspileTarget } from "../compiler/runtime/transpile";
import { basename, extname, resolve } from "../compiler/utils/path";
import { monotonicNow, roundedMilliseconds } from "../compiler/utils/time";
import {
  ambientDeclarationsForProject,
  createBundledModuleArtifacts,
  ensureRuntimeDependencies,
  resolveProjectForSource
} from "./cliShared";

interface CompilationPhaseTimings {
  parseMs: number;
  analysisMs: number;
  emitMs: number;
}

export interface ServeOptions {
  rootDir: string;
  bundleInput: string;
  port?: number;
  target?: TranspileTarget;
  jsxFactory?: string;
  jsxFragmentFactory?: string;
  onDiagnosticError?: (result: { errors: string[]; diagnostics?: TranspileDiagnostic[] }, file: string) => void;
}

export interface RunningServeSession {
  close(): Promise<void>;
  port: number;
}

const LIVE_RELOAD_PATH = "/__vexa_live_reload";
const BUNDLE_PATH = "/__vexa_bundle__.js";
const LOOPBACK_HOST = "127.0.0.1";
const REBUILD_DEBOUNCE_MS = 20;

function formatBundleTiming(elapsedMs: number, timings: CompilationPhaseTimings): string {
  return `Bundled in ${roundedMilliseconds(elapsedMs)}ms ` +
    `(parse ${roundedMilliseconds(timings.parseMs)}ms, ` +
    `analysis ${roundedMilliseconds(timings.analysisMs)}ms, ` +
    `emit ${roundedMilliseconds(timings.emitMs)}ms)`;
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8"
};

function injectedHtmlDocument(html: string): string {
  const snippet = [
    `<script>`,
    `(() => {`,
    `  const source = new EventSource(${JSON.stringify(LIVE_RELOAD_PATH)});`,
    `  source.addEventListener("reload", () => window.location.reload());`,
    `})();`,
    `</script>`
  ].join("");
  const withEntrypoint = html.split("%VEXA_ENTRYPOINT%").join(BUNDLE_PATH);
  if (withEntrypoint.includes("</body>")) {
    return withEntrypoint.replace("</body>", `${snippet}</body>`);
  }
  if (withEntrypoint.includes("</html>")) {
    return withEntrypoint.replace("</html>", `${snippet}</html>`);
  }
  return `${withEntrypoint}${snippet}`;
}

function respond(response: ServerResponse<IncomingMessage>, statusCode: number, body: string, contentType: string): void {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-cache"
  });
  response.end(body);
}

function isWithinRoot(rootDir: string, targetPath: string): boolean {
  return targetPath === rootDir || targetPath.startsWith(`${rootDir}/`);
}

async function resolveServePath(rootDir: string, requestPath: string): Promise<string | null> {
  const decoded = decodeURIComponent(requestPath.split("?")[0] ?? "/");
  const normalized = decoded === "/" ? "/index.html" : decoded;
  const absolutePath = resolve(rootDir, `.${normalized}`);
  if (!isWithinRoot(rootDir, absolutePath)) {
    return null;
  }
  return absolutePath;
}

async function resolveMappedServePath(mappings: readonly VexaServeMapping[], requestPath: string): Promise<string | null> {
  const decoded = decodeURIComponent(requestPath.split("?")[0] ?? "/");
  const normalized = resolve("/", decoded === "/" ? "/index.html" : `.${decoded}`).slice(1);
  for (const mapping of mappings) {
    const targetPath = mapping.to;
    if (normalized !== targetPath && !normalized.startsWith(`${targetPath}/`)) {
      continue;
    }

    const sourceInfo = await stat(mapping.from).catch(() => null);
    if (!sourceInfo) {
      continue;
    }
    if (sourceInfo.isFile()) {
      return normalized === targetPath ? mapping.from : null;
    }

    const suffix = normalized === targetPath ? "" : normalized.slice(targetPath.length + 1);
    const sourcePath = resolve(mapping.from, suffix);
    if (!isWithinRoot(mapping.from, sourcePath)) {
      return null;
    }
    return sourcePath;
  }
  return null;
}

async function listenOnAvailablePort(server: ReturnType<typeof createServer>, requestedPort: number): Promise<number> {
  let port = requestedPort;
  while (true) {
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolvePromise();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, LOOPBACK_HOST);
      });
      const address = server.address();
      return typeof address === "object" && address ? (address as AddressInfo).port : port;
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException | undefined)?.code;
      if (errorCode !== "EADDRINUSE" || port === 0) {
        throw error;
      }
      port += 1;
    }
  }
}

export async function startServeSession(options: ServeOptions): Promise<RunningServeSession> {
  const rootDir = resolve(process.cwd(), options.rootDir);
  const bundleInput = resolve(process.cwd(), options.bundleInput);
  const requestedPort = options.port ?? 8080;
  const target = options.target ?? "optimized";
  const jsxOptions = {
    ...(options.jsxFactory ? { jsxFactory: options.jsxFactory } : {}),
    ...(options.jsxFragmentFactory ? { jsxFragmentFactory: options.jsxFragmentFactory } : {})
  };

  const clients = new Set<ServerResponse<IncomingMessage>>();
  const watcherAbortControllers = new Map<string, AbortController>();
  const watchedFileVersions = new Map<string, string | null>();
  const pendingChangedFiles = new Set<string>();
  const forcedChangedFiles = new Set<string>();
  let pendingRebuildTimer: NodeJS.Timeout | null = null;
  let rebuildInProgress = false;
  let closed = false;
  let bundleCode = "";
  let bundleVersion = 0;
  let pendingInitialBundleDurationMs: number | null = null;
  let pendingInitialPhaseTimings: CompilationPhaseTimings | null = null;
  const project = await resolveProjectForSource(bundleInput);
  let serveMappings: VexaServeMapping[] = project?.serveMappings ?? [];
  await ensureRuntimeDependencies(bundleInput, project);
  const ambientDeclarations = await ambientDeclarationsForProject(bundleInput, project);
  const { createModuleGraphIncrementalCache } = await import("../compiler/runtime/moduleGraph");
  const { createNodeModuleBundleIncrementalCache } = await import("./nodeModuleBundle");
  const moduleGraphIncrementalCache = createModuleGraphIncrementalCache();
  const nodeModuleIncrementalCache = createNodeModuleBundleIncrementalCache();

  const closeWatchers = (): void => {
    for (const controller of watcherAbortControllers.values()) {
      controller.abort();
    }
    watcherAbortControllers.clear();
  };

  const broadcastReload = (): void => {
    for (const client of clients) {
      client.write("event: reload\n");
      client.write(`data: ${bundleVersion}\n\n`);
    }
  };

  const fileVersion = async (filePath: string): Promise<string | null> => {
    const info = await stat(filePath).catch(() => null);
    return info ? `${info.mtimeMs}:${info.size}` : null;
  };

  const updateWatchedFileVersions = async (filePaths: readonly string[]): Promise<void> => {
    const versions = await Promise.all(filePaths.map(async (filePath) => [filePath, await fileVersion(filePath)] as const));
    watchedFileVersions.clear();
    for (const [filePath, version] of versions) watchedFileVersions.set(filePath, version);
  };

  const schedulePendingRebuild = (): void => {
    if (closed || rebuildInProgress || pendingChangedFiles.size === 0) return;
    if (pendingRebuildTimer) {
      clearTimeout(pendingRebuildTimer);
    }
    pendingRebuildTimer = setTimeout(() => {
      pendingRebuildTimer = null;
      void drainPendingRebuild().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
      });
    }, REBUILD_DEBOUNCE_MS);
  };

  const scheduleRebuild = (filePath: string): void => {
    if (closed) return;
    pendingChangedFiles.add(filePath);
    schedulePendingRebuild();
  };

  const syncWatchers = (filePaths: readonly string[]): void => {
    const nextFiles = new Set(filePaths);
    for (const [filePath, controller] of watcherAbortControllers) {
      if (nextFiles.has(filePath)) continue;
      controller.abort();
      watcherAbortControllers.delete(filePath);
    }
    for (const filePath of nextFiles) {
      if (watcherAbortControllers.has(filePath)) continue;
      const controller = new AbortController();
      watcherAbortControllers.set(filePath, controller);
      void (async () => {
        try {
          for await (const _event of watch(filePath, { signal: controller.signal })) {
            scheduleRebuild(filePath);
          }
        } catch (error) {
          if ((error as { name?: string } | undefined)?.name !== "AbortError") {
            scheduleRebuild(filePath);
          }
        } finally {
          if (watcherAbortControllers.get(filePath) === controller) {
            watcherAbortControllers.delete(filePath);
          }
        }
      })();
    }
  };

  const rebuildBundle = async (reason: string, changedFiles: readonly string[]): Promise<void> => {
    const startedAt = monotonicNow();
    const phaseTimings = { parseMs: 0, analysisMs: 0, emitMs: 0 };
    const versionsBeforeBuild = new Map<string, string | null>();
    for (const filePath of changedFiles) versionsBeforeBuild.set(filePath, await fileVersion(filePath));
    const result = await createBundledModuleArtifacts(bundleInput, target, project, jsxOptions, {
      ambientDeclarations,
      moduleGraphIncrementalCache,
      nodeModuleIncrementalCache,
      changedFiles,
      profile: (event) => {
        if (event.phase === "parse") phaseTimings.parseMs += event.elapsedMs;
        if (event.phase === "analysis") phaseTimings.analysisMs += event.elapsedMs;
        if (event.phase === "emit") phaseTimings.emitMs += event.elapsedMs;
      }
    });
    if (result.errors.length > 0) {
      options.onDiagnosticError?.(result, bundleInput);
      if (reason === "initial") {
        throw new Error(`Compilation failed for ${bundleInput}`);
      }
      return;
    }
    bundleCode = result.code;
    bundleVersion += 1;
    syncWatchers(result.watchedFiles);
    await updateWatchedFileVersions(result.watchedFiles);
    for (const [filePath, versionBeforeBuild] of versionsBeforeBuild) {
      if (watchedFileVersions.get(filePath) !== versionBeforeBuild) {
        pendingChangedFiles.add(filePath);
        forcedChangedFiles.add(filePath);
      }
    }
    const elapsedMs = monotonicNow() - startedAt;
    if (reason === "initial") {
      pendingInitialBundleDurationMs = elapsedMs;
      pendingInitialPhaseTimings = phaseTimings;
    } else {
      console.log(formatBundleTiming(elapsedMs, phaseTimings));
      broadcastReload();
    }
  };

  const drainPendingRebuild = async (): Promise<void> => {
    if (closed || rebuildInProgress) return;
    const candidates = [...pendingChangedFiles];
    pendingChangedFiles.clear();
    const changedFiles: string[] = [];
    for (const filePath of candidates) {
      if (forcedChangedFiles.delete(filePath) || await fileVersion(filePath) !== watchedFileVersions.get(filePath)) {
        changedFiles.push(filePath);
      }
    }
    if (changedFiles.length === 0) {
      schedulePendingRebuild();
      return;
    }
    rebuildInProgress = true;
    try {
      await rebuildBundle(`change:${changedFiles.map(basename).join(",")}`, changedFiles);
    } finally {
      rebuildInProgress = false;
      schedulePendingRebuild();
    }
  };

  await rebuildBundle("initial", []);

  const server = createServer(async (request, response) => {
    const requestUrl = request.url ?? "/";
    if (requestUrl.startsWith(LIVE_RELOAD_PATH)) {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      response.write(`event: ready\ndata: ${bundleVersion}\n\n`);
      clients.add(response);
      request.on("close", () => {
        clients.delete(response);
        response.end();
      });
      return;
    }

    if (requestUrl.startsWith(BUNDLE_PATH)) {
      respond(response, 200, bundleCode, CONTENT_TYPES[".js"] ?? "text/javascript; charset=utf-8");
      return;
    }

    const mappedPath = await resolveMappedServePath(serveMappings, requestUrl);
    const filePath = mappedPath ?? await resolveServePath(rootDir, requestUrl);
    if (!filePath) {
      respond(response, 403, "Forbidden", "text/plain; charset=utf-8");
      return;
    }

    try {
      const content = await readFile(filePath);
      const extension = extname(filePath).toLowerCase();
      const contentType = CONTENT_TYPES[extension] ?? "application/octet-stream";
      if (extension === ".html") {
        respond(response, 200, injectedHtmlDocument(content.toString("utf8")), contentType);
        return;
      }
      response.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-cache"
      });
      response.end(content);
    } catch {
      if (extname(filePath) === "") {
        try {
          const content = await readFile(`${filePath}.html`, "utf8");
          respond(response, 200, injectedHtmlDocument(content), CONTENT_TYPES[".html"] ?? "text/html; charset=utf-8");
          return;
        } catch {
          // fall through
        }
      }
      respond(response, 404, "Not found", "text/plain; charset=utf-8");
    }
  });

  const port = await listenOnAvailablePort(server, requestedPort);
  console.log(`Serving at http://localhost:${port} -- ${rootDir}`);
  if (pendingInitialBundleDurationMs !== null && pendingInitialPhaseTimings !== null) {
    console.log(formatBundleTiming(pendingInitialBundleDurationMs, pendingInitialPhaseTimings));
    pendingInitialBundleDurationMs = null;
    pendingInitialPhaseTimings = null;
  }

  return {
    port,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      if (pendingRebuildTimer) {
        clearTimeout(pendingRebuildTimer);
        pendingRebuildTimer = null;
      }
      closeWatchers();
      for (const client of clients) {
        client.end();
      }
      clients.clear();
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolvePromise();
        });
      });
    }
  };
}
