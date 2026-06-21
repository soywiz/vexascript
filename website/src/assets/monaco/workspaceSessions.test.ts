import { describe, expect, it } from "compiler/test/expect";
import { createAnalysisSession } from "compiler/lsp/analysisSession";
import { collectAllImportedDeclarations } from "compiler/lsp/importedDeclarations";
import { resolveDefinitionWithLocalFallback, resolveMemberHoverAcrossFiles } from "compiler/lsp/crossFileNavigation";
import { ensureDomProgram } from "compiler/runtime/domDeclarations";
import { parseSource } from "compiler/pipeline/parse";
import { setVfs } from "compiler/vfs";
import {
  createFileEntry,
  createFolderEntry,
  pathToUri,
  type WorkspaceEntry,
} from "./workspace";
import { createCachedWorkspaceSessionResolver } from "./workspaceSessions";
import { WorkspaceVfs } from "./workspaceVfs";

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1]! + sorted[middle]!) / 2;
  }
  return sorted[middle]!;
}

async function measureMedianMs(samples: number, run: () => Promise<void>): Promise<number> {
  const measurements: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const start = performance.now();
    await run();
    measurements.push(performance.now() - start);
  }
  return median(measurements);
}

function playgroundWorkspaceSources(): Map<string, string> {
  return new Map<string, string>([
    ["/src/main.vx", `
import { increment, LoggedProperty } from "./counter.vx"
import { Point } from "./point.vx"
import { TimeSpan, delay, seconds, milliseconds, operator+, operator/ } from "./time.vx"
import { drawCard, drawDot } from "./c2d.vx"

fun describe(point: Point): string {
  return \`(\${point.x}, \${point.y})\`
}

val cardOrigin = Point(36, 28)
val cardSize = Point(248, 116)
val pulseCenter = cardOrigin + Point(190, 58)
val pulseDelay = 1.seconds + 250.milliseconds

sync fun example() {
  val current = increment(41)
  console.log(current.toString())
  console.log(describe(pulseCenter))

  val app = document.querySelector("#app")!
  val canvas = document.createElement("canvas")
  canvas
    ..width = 320
    ..height = 180
  app.append(canvas)

  const c2d = canvas.getContext("2d")!
  c2d
    ..fillStyle = "#f4f8fc"
    ..fillRect(0, 0, canvas.width, canvas.height)
    ..drawCard(cardOrigin, cardSize, "#8cb3d9", "VexaScript")
    ..drawDot(pulseCenter, 12, "#17324d")

  let prop by LoggedProperty(10)
  prop++

  for (n in 0..<80) {
    c2d.drawDot(pulseCenter, 18 + n / 4.0, "#4d7ea8")
    c2d.drawDot(pulseCenter, 12 - n / 20.0, "#17324d")
    delay(pulseDelay / 100)
  }

  prop += 5

  console.log(TimeSpan(500.0).ms)
  console.log((pulseDelay + 500.milliseconds).ms)
}

example()
`.trim()],
    ["/src/c2d.vx", `
import { Point } from "./point.vx"

/// Renders a circle at [p] with [radius]
export fun CanvasRenderingContext2D.circle(p: Point, radius: number) {
  beginPath()
  arc(p.x, p.y, radius, 0, Math.PI * 2)
}

/// Renders current shape with a fill with [style]
export fun CanvasRenderingContext2D.fillWithStyle(style: string | CanvasGradient | CanvasPattern) {
  fillStyle = style
  fill()
}

export fun CanvasRenderingContext2D.drawCard(origin: Point, size: Point, fill: string, label: string) {
  fillStyle = fill
  fillRect(origin.x, origin.y, size.x, size.y)
  fillStyle = "#17324d"
  font = "bold 18px sans-serif"
  fillText(label, origin.x + 16, origin.y + 32)
}

export fun CanvasRenderingContext2D.drawDot(center: Point, radius: number, fill: string) {
  circle(center, radius)
  fillWithStyle(fill)
}
`.trim()],
    ["/src/counter.vx", `
export fun increment(value: int): int = value + 1

class LoggedProperty(initialValue: int) {
  private var current = initialValue

  getter => current
  setter(newValue) {
    console.log("changed value " + current.toString() + " -> " + newValue.toString())
    current = newValue
  }
}
`.trim()],
    ["/src/point.vx", `class Point(var x: number, var y: number)`],
    ["/src/time.vx", `
class TimeSpan(val ms: number)

export val number.seconds: TimeSpan
  getter => TimeSpan(this * 1000)

export val number.milliseconds: TimeSpan
  getter => TimeSpan(this)

export fun delay(milliseconds: TimeSpan) {}

export fun TimeSpan.operator+(other: TimeSpan): TimeSpan = TimeSpan(ms + other.ms)
export fun TimeSpan.operator/(divisor: number): TimeSpan = TimeSpan(ms / divisor)
`.trim()],
  ]);
}

function createWorkspaceEntries(files: Map<string, string>): WorkspaceEntry[] {
  return [
    createFolderEntry("/"),
    createFolderEntry("/src"),
    ...Array.from(files.entries(), ([path, content]) => createFileEntry(path, content)),
  ];
}

async function createPlaygroundHarness() {
  const files = playgroundWorkspaceSources();
  const entries = createWorkspaceEntries(files);
  const workspaceVfs = new WorkspaceVfs({
    getEntries: () => entries,
    readWorkspaceFile: (uri) => {
      const entry = entries.find((candidate) => candidate.kind === "file" && candidate.uri === uri);
      return entry?.kind === "file" ? entry.content : null;
    },
  });
  setVfs(workspaceVfs);

  const ambientDeclarations = (await ensureDomProgram()).body;
  let workspaceRevision = 0;
  let sessionBuilds = 0;
  const getWorkspaceFileSource = (uri: string): string | null => {
    const entry = entries.find((candidate) => candidate.kind === "file" && candidate.uri === uri);
    return entry?.kind === "file" ? entry.content : null;
  };
  const getSessionForFilePath = createCachedWorkspaceSessionResolver({
    getAmbientDeclarations: async () => {
      sessionBuilds++;
      return ambientDeclarations;
    },
    getWorkspaceFileSource,
    getWorkspaceRevision: () => workspaceRevision,
    pathToUri,
  });

  const mainPath = "/src/main.vx";
  const mainUri = pathToUri(mainPath);
  const mainSource = files.get(mainPath)!;
  const mainAst = parseSource(mainSource).ast!;
  const resolverContext = {
    uri: mainUri,
    sourceRoots: [],
    vfs: workspaceVfs,
    getSessionForFilePath,
    getExportedSymbols: async () => [],
  };
  const lineIndex = mainSource.split("\n").findIndex((line) => line.includes('..drawDot(pulseCenter, 12, "#17324d")'));
  const character = mainSource.split("\n")[lineIndex]!.indexOf("drawDot") + 2;

  return {
    ambientDeclarations,
    character,
    entries,
    files,
    getSessionForFilePath,
    getWorkspaceFileSource,
    lineIndex,
    mainAst,
    mainPath,
    mainSource,
    resolverContext,
    sessionBuildCount: () => sessionBuilds,
    workspaceRevision: () => workspaceRevision,
    bumpWorkspaceRevision: () => {
      workspaceRevision++;
    },
  };
}

async function buildOptimizedPlaygroundSession(
  mainSource: string,
  mainAst: NonNullable<ReturnType<typeof parseSource>["ast"]>,
  ambientDeclarations: Awaited<ReturnType<typeof ensureDomProgram>>["body"],
  resolverContext: {
    uri: string;
    sourceRoots: string[];
    vfs: WorkspaceVfs;
    getSessionForFilePath(filePath: string): Promise<ReturnType<typeof createAnalysisSession> | null>;
    getExportedSymbols(): Promise<never[]>;
  },
) {
  const collected = await collectAllImportedDeclarations(mainAst, resolverContext);
  return createAnalysisSession(mainSource, { externalDeclarations: collected.externalDeclarations, ambientDeclarations, importedSymbols: collected.importedSymbols });
}

async function buildLegacyPlaygroundSession(
  mainSource: string,
  ambientDeclarations: Awaited<ReturnType<typeof ensureDomProgram>>["body"],
  resolverContext: {
    uri: string;
    sourceRoots: string[];
    vfs: WorkspaceVfs;
    getSessionForFilePath(filePath: string): Promise<ReturnType<typeof createAnalysisSession> | null>;
    getExportedSymbols(): Promise<never[]>;
  },
) {
  const baseSession = createAnalysisSession(mainSource, { ambientDeclarations: ambientDeclarations });
  const ast = baseSession.ast;
  if (!ast) {
    return createAnalysisSession(mainSource, { ambientDeclarations: ambientDeclarations });
  }
  const collected = await collectAllImportedDeclarations(ast, resolverContext);
  return createAnalysisSession(mainSource, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols, ambientDeclarations: ambientDeclarations });
}

describe("workspace session cache", () => {
  it("reuses imported workspace sessions across repeated hover and definition requests", async () => {
    const harness = await createPlaygroundHarness();
    const mainSession = await buildOptimizedPlaygroundSession(
      harness.mainSource,
      harness.mainAst,
      harness.ambientDeclarations,
      harness.resolverContext,
    );

    const hover1 = await resolveMemberHoverAcrossFiles({
      line: harness.lineIndex,
      character: harness.character,
      session: mainSession,
      ...harness.resolverContext,
    });
    const definition1 = await resolveDefinitionWithLocalFallback({
      line: harness.lineIndex,
      character: harness.character,
      session: mainSession,
      ...harness.resolverContext,
    });
    const hover2 = await resolveMemberHoverAcrossFiles({
      line: harness.lineIndex,
      character: harness.character,
      session: mainSession,
      ...harness.resolverContext,
    });
    const definition2 = await resolveDefinitionWithLocalFallback({
      line: harness.lineIndex,
      character: harness.character,
      session: mainSession,
      ...harness.resolverContext,
    });

    expect(hover1).not.toBeNull();
    expect(hover2).not.toBeNull();
    expect((hover1?.contents as { value?: string } | undefined)?.value).toContain("drawDot");
    expect(definition1?.uri).toBe("file:///src/c2d.vx");
    expect(definition2?.uri).toBe("file:///src/c2d.vx");
    expect(harness.sessionBuildCount()).toBeLessThanOrEqual(harness.files.size);

    harness.bumpWorkspaceRevision();
  });

  it("invalidates cached sessions when the workspace revision changes", async () => {
    const files = new Map<string, string>([
      ["/src/example.vx", "const value = 1"],
    ]);
    const entries = createWorkspaceEntries(files);
    const getWorkspaceFileSource = (uri: string): string | null => {
      const entry = entries.find((candidate) => candidate.kind === "file" && candidate.uri === uri);
      return entry?.kind === "file" ? entry.content : null;
    };

    let workspaceRevision = 0;
    let sessionBuilds = 0;
    const getSessionForFilePath = createCachedWorkspaceSessionResolver({
      getAmbientDeclarations: async () => {
        sessionBuilds++;
        return [];
      },
      getWorkspaceFileSource,
      getWorkspaceRevision: () => workspaceRevision,
      pathToUri,
    });

    const first = await getSessionForFilePath("/src/example.vx");
    const second = await getSessionForFilePath("/src/example.vx");
    workspaceRevision++;
    const third = await getSessionForFilePath("/src/example.vx");

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(third).not.toBeNull();
    expect(third).not.toBe(first);
    expect(sessionBuilds).toBe(2);
  });

  it("keeps the optimized playground path measurably below the legacy cold path", async () => {
    const optimizedSamples: number[] = [];
    const legacySamples: number[] = [];
    const coldResolverSamples: number[] = [];
    const warmResolverSamples: number[] = [];

    for (let index = 0; index < 5; index += 1) {
      const harness = await createPlaygroundHarness();
      legacySamples.push(await measureMedianMs(3, async () => {
        await buildLegacyPlaygroundSession(
          harness.mainSource,
          harness.ambientDeclarations,
          harness.resolverContext,
        );
      }));
      optimizedSamples.push(await measureMedianMs(3, async () => {
        await buildOptimizedPlaygroundSession(
          harness.mainSource,
          harness.mainAst,
          harness.ambientDeclarations,
          harness.resolverContext,
        );
      }));

      coldResolverSamples.push(await measureMedianMs(3, async () => {
        const importedSession = await harness.getSessionForFilePath("/src/c2d.vx");
        expect(importedSession).not.toBeNull();
      }));
      const buildsAfterColdResolve = harness.sessionBuildCount();
      await harness.getSessionForFilePath("/src/c2d.vx");
      warmResolverSamples.push(await measureMedianMs(3, async () => {
        const importedSession = await harness.getSessionForFilePath("/src/c2d.vx");
        expect(importedSession).not.toBeNull();
      }));
      expect(harness.sessionBuildCount()).toBe(buildsAfterColdResolve);
    }

    const legacyMedianMs = median(legacySamples);
    const optimizedMedianMs = median(optimizedSamples);
    const coldResolverMedianMs = median(coldResolverSamples);
    const warmResolverMedianMs = median(warmResolverSamples);

    console.log(
      `playground latency benchmark legacy=${legacyMedianMs.toFixed(3)}ms optimized=${optimizedMedianMs.toFixed(3)}ms coldResolver=${coldResolverMedianMs.toFixed(3)}ms warmResolver=${warmResolverMedianMs.toFixed(3)}ms`,
    );

    expect(optimizedMedianMs).toBeLessThan(legacyMedianMs);
  });
});
