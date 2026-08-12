import { describe, expect, it, readFile, resolve } from "../compiler/test/expect";
import { ensureRuntimeDependencies, resolveProjectForSource } from "../cli/cliShared";
import { openEntrypointInLspSession, type LspPositionProbe } from "./lspOpenSession";

function positionInside(source: string, text: string): LspPositionProbe {
  const offset = source.indexOf(text);
  if (offset < 0) throw new Error(`Expected sample source to contain '${text}'`);
  const before = source.slice(0, offset + Math.max(1, Math.floor(text.length / 2)));
  const lines = before.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

function positionAfter(source: string, text: string): LspPositionProbe {
  const offset = source.lastIndexOf(text);
  if (offset < 0) throw new Error(`Expected sample source to contain '${text}'`);
  const before = source.slice(0, offset + text.length);
  const lines = before.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

function hoverText(value: unknown): string {
  return ((value as { contents?: { value?: string } } | null)?.contents?.value ?? "");
}

async function openSampleFile(
  relativePath: string,
  hoverTexts: string[],
  completionTexts: string[],
  requiredDefinitionCount: number = hoverTexts.length
) {
  const sourcePath = resolve(process.cwd(), "samples/preact", relativePath);
  const source = await readFile(sourcePath, "utf8");
  const project = await resolveProjectForSource(sourcePath);
  await ensureRuntimeDependencies(sourcePath, project);
  const result = await openEntrypointInLspSession(
    sourcePath,
    process.cwd(),
    hoverTexts.map((text) => positionInside(source, text)),
    completionTexts.map((text) => positionAfter(source, text))
  );
  expect(result.documentDiagnostics).toEqual([]);
  expect(result.workspaceDiagnostics).toEqual([]);
  result.definitions.slice(0, requiredDefinitionCount).forEach((definition, index) => {
    if (definition === null) throw new Error(`Missing definition for '${hoverTexts[index]}' in ${relativePath}`);
  });
  return { result, hovers: result.hovers.map(hoverText) };
}

describe("preact JSX editor features", () => {
  it("keeps advanced hooks and context typed across the project", async () => {
    const { result, hovers } = await openSampleFile(
      "src/App.vx",
      ["useReducer", "useErrorBoundary", "useLayoutEffect", "currentTheme"],
      ["theme."],
      3
    );

    expect(hovers[0]).toContain("useReducer");
    expect(hovers[1]).toContain("useErrorBoundary");
    expect(hovers[2]).toContain("useLayoutEffect");
    expect(hovers[3]).toContain("Theme");
    expect(result.completions[0]?.some((item) => item.label === "accent")).toBe(true);
  });

  it("keeps forms, event targets and imperative refs typed", async () => {
    const { result, hovers } = await openSampleFile(
      "src/forms.vx",
      ["useImperativeHandle", "onInput", "currentTarget"],
      ["event.currentTarget.", "formRef.current?."],
      3
    );

    expect(hovers[0]).toContain("useImperativeHandle");
    expect(hovers[1]).toContain("HTMLInputElement");
    expect(hovers[2]).toContain("HTMLInputElement");
    expect(result.completions[0]?.some((item) => item.label === "value")).toBe(true);
    expect(result.completions[0]?.some((item) => item.label === "selectionStart")).toBe(true);
    expect(result.completions[1]?.some((item) => item.label === "focus")).toBe(true);
  });

  it("keeps signals, class components and lifecycle APIs typed", async () => {
    const { result, hovers } = await openSampleFile(
      "src/components.vx",
      ["useSignal", "useComputed", "useSignalEffect", "componentDidMount"],
      ["theme.", "visibleTasks.value."]
    );

    expect(hovers[0]).toContain("useSignal");
    expect(hovers[1]).toContain("useComputed");
    expect(hovers[2]).toContain("useSignalEffect");
    expect(hovers[3]).toContain("componentDidMount");
    expect(result.completions[0]?.some((item) => item.label === "accent")).toBe(true);
    expect(result.completions[1]?.some((item) => item.label === "map")).toBe(true);
  });

  it("keeps core signal primitives typed in shared state", async () => {
    const { hovers } = await openSampleFile(
      "src/tasks.vx",
      ["signal", "computed", "effect", "peek"],
      []
    );

    expect(hovers[0]).toContain("signal");
    expect(hovers[1]).toContain("computed");
    expect(hovers[2]).toContain("effect");
    expect(hovers[3]).toContain("peek");
  });

  it("preserves an inferred signal type through a transitive local import", async () => {
    const { result, hovers } = await openSampleFile(
      "src/hooks.vx",
      ["visibleTasks", "value"],
      ["visibleTasks.value."]
    );

    expect(hovers[0]).toContain("ReadonlySignal<Task[]>");
    expect(hovers[1]).toContain("Task[]");
    expect(result.completions[0]?.some((item) => item.label === "length")).toBe(true);
    expect(result.completions[0]?.some((item) => item.label === "map")).toBe(true);
    const valueDefinition = Array.isArray(result.definitions[1])
      ? result.definitions[1][0]
      : result.definitions[1];
    expect(decodeURIComponent(valueDefinition?.uri ?? "")).toContain("/@preact/signals-core/dist/signals-core.d.ts");
    expect(valueDefinition?.range.start).toEqual({ line: 81, character: 13 });
  });
});
