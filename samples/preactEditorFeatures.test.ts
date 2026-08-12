import { describe, expect, it, readFile, resolve } from "../compiler/test/expect";
import { ensureRuntimeDependencies, resolveProjectForSource } from "../cli/cliShared";
import { VEXA_SEMANTIC_TOKENS_LEGEND } from "../compiler/lsp/semanticTokens";
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

function semanticTokenType(source: string, text: string, data: number[], occurrence: number = 0): string | undefined {
  let offset = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    offset = source.indexOf(text, offset + 1);
  }
  if (offset < 0) throw new Error(`Expected sample source to contain '${text}'`);
  const before = source.slice(0, offset);
  const targetLine = before.split("\n").length - 1;
  const targetCharacter = before.length - (before.lastIndexOf("\n") + 1);
  let line = 0;
  let character = 0;

  for (let index = 0; index < data.length; index += 5) {
    const deltaLine = data[index] ?? 0;
    line += deltaLine;
    character = deltaLine === 0 ? character + (data[index + 1] ?? 0) : (data[index + 1] ?? 0);
    if (line === targetLine && character === targetCharacter && data[index + 2] === text.length) {
      return VEXA_SEMANTIC_TOKENS_LEGEND.tokenTypes[data[index + 3] ?? -1];
    }
  }

  return undefined;
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
  return { source, result, hovers: result.hovers.map(hoverText) };
}

describe("preact JSX editor features", () => {
  it("keeps advanced hooks and context typed across the project", async () => {
    const { source, result, hovers } = await openSampleFile(
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
    expect(semanticTokenType(source, "class", result.semanticTokens.data)).toBe("jsxAttribute");
    expect(semanticTokenType(source, '"eyebrow"', result.semanticTokens.data)).toBe("stringLiteral");
  });

  it("keeps forms, event targets and imperative refs typed", async () => {
    const { source, result, hovers } = await openSampleFile(
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
    expect(semanticTokenType(source, "FilterControls", result.semanticTokens.data)).toBe("function");
    expect(semanticTokenType(source, "FilterControls", result.semanticTokensRange.data)).toBe("function");
    for (const attribute of ["class", "ref", "onInput", "aria-label"]) {
      expect(semanticTokenType(source, attribute, result.semanticTokens.data)).toBe("jsxAttribute");
    }
  });

  it("keeps signals, class components and lifecycle APIs typed", async () => {
    const { source, result, hovers } = await openSampleFile(
      "src/components.vx",
      ["useSignal", "useComputed", "useSignalEffect", "componentDidMount"],
      ["theme.", "visibleTasks."]
    );

    expect(hovers[0]).toContain("useSignal");
    expect(hovers[1]).toContain("useComputed");
    expect(hovers[2]).toContain("useSignalEffect");
    expect(hovers[3]).toContain("componentDidMount");
    expect(result.completions[0]?.some((item) => item.label === "accent")).toBe(true);
    expect(result.completions[1]?.some((item) => item.label === "value")).toBe(true);
    expect(semanticTokenType(source, "Fragment", result.semanticTokens.data, 1)).toBe("function");
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
