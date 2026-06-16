import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, watch } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { TranspileDiagnostic, TranspileTarget } from "./runtime/transpile";
import { basename, extname, resolve } from "./utils/path";
import {
  createBundledModuleArtifacts,
  ensureCompilerRuntimePrograms,
  ensureRuntimeDependencies,
  resolveProjectForSource
} from "./cliShared";

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
  let pendingRebuildTimer: NodeJS.Timeout | null = null;
  let closed = false;
  let bundleCode = "";
  let bundleVersion = 0;

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

  const scheduleRebuild = (reason: string): void => {
    if (closed) {
      return;
    }
    if (pendingRebuildTimer) {
      clearTimeout(pendingRebuildTimer);
    }
    pendingRebuildTimer = setTimeout(() => {
      pendingRebuildTimer = null;
      void rebuildBundle(reason).catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
      });
    }, 75);
  };

  const rebuildBundle = async (reason: string): Promise<void> => {
    const startedAt = Date.now();
    const project = await resolveProjectForSource(bundleInput);
    await ensureRuntimeDependencies(bundleInput, project);
    await ensureCompilerRuntimePrograms();
    const result = await createBundledModuleArtifacts(bundleInput, target, project, jsxOptions);
    if (result.errors.length > 0) {
      options.onDiagnosticError?.(result, bundleInput);
      if (reason === "initial") {
        throw new Error(`Compilation failed for ${bundleInput}`);
      }
      return;
    }
    bundleCode = result.code;
    bundleVersion += 1;
    closeWatchers();
    for (const filePath of result.watchedFiles) {
      const controller = new AbortController();
      watcherAbortControllers.set(filePath, controller);
      void (async () => {
        try {
          for await (const _event of watch(filePath, { signal: controller.signal })) {
            scheduleRebuild(`change:${basename(filePath)}`);
          }
        } catch (error) {
          if ((error as { name?: string } | undefined)?.name !== "AbortError") {
            scheduleRebuild(`change:${basename(filePath)}`);
          }
        }
      })();
    }
    if (reason !== "initial") {
      const elapsedMs = Date.now() - startedAt;
      console.log(`Rebundled: ${bundleInput} (${reason}, ${elapsedMs}ms)`);
      broadcastReload();
    }
  };

  await rebuildBundle("initial");

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

    const filePath = await resolveServePath(rootDir, requestUrl);
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

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? (address as AddressInfo).port : requestedPort;
  console.log(`Serving ${rootDir} at http://localhost:${port} with bundle ${bundleInput}`);

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
