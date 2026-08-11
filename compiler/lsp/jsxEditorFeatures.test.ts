import { describe, expect, it, join, mkdir, mkdtemp, pathToFileURL, tmpdir, writeFile } from "../test/expect";
import { sourceWithCursor } from "../test/sourceWithCursor";
import dedent from "compiler/utils/dedent";
import { parseSource } from "compiler/pipeline/parse";
import { createAnalysisSession } from "./analysisSession";
import { createCompletionItemsForPosition } from "./completion";
import { resolveDefinitionWithLocalFallback, resolveHoverWithLocalFallback } from "./crossFileNavigation";
import { collectAllImportedDeclarations } from "./importedDeclarations";

async function createPreactJsxSession(source: string) {
  const root = await mkdtemp(join(tmpdir(), "vexa-jsx-editor-features-"));
  const packageDir = join(root, "node_modules", "preact");
  const preactPath = join(packageDir, "index.d.ts");
  const domPath = join(root, "dom.d.ts");
  const consumerPath = join(root, "consumer.vx");
  const preactSource = dedent`
    export namespace JSXInternal {
      export type TargetedEvent<Target extends EventTarget> = {
        readonly currentTarget: Target
      }
      export type EventHandler<E> = {
        bivarianceHack(event: E): void
      }["bivarianceHack"]
      export type MouseEventHandler<Target extends EventTarget> = EventHandler<TargetedEvent<Target>>
      export interface DOMAttributes<Target extends EventTarget> {
        onClick?: MouseEventHandler<Target> | undefined
      }
      export interface ButtonHTMLAttributes<Target extends EventTarget> extends DOMAttributes<Target> {}
      export interface IntrinsicElements {
        button: ButtonHTMLAttributes<HTMLButtonElement>
        div: {}
      }
    }

    export function render(value: unknown, parent: Element): void
  `;
  const domSource = dedent`
    interface EventTarget {}
    interface Element extends EventTarget {}
    interface HTMLElement extends Element {}
    interface HTMLButtonElement extends HTMLElement {}
  `;

  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "preact", types: "index.d.ts" }), "utf8");
  await writeFile(preactPath, preactSource, "utf8");
  await writeFile(domPath, domSource, "utf8");
  await writeFile(consumerPath, source, "utf8");

  const domProgram = parseSource(domSource, { language: "typescript" }).ast!;
  const ambientDeclarationLocations = new Map(
    domProgram.body.map((statement) => [statement, {
      filePath: domPath,
      line: statement.firstToken?.range.start.line ?? 0,
      character: statement.firstToken?.range.start.column ?? 0
    }])
  );
  const baseSession = createAnalysisSession(source, {
    ambientDeclarations: domProgram.body,
    ambientDeclarationLocations
  });
  const context = {
    uri: pathToFileURL(consumerPath).toString(),
    sourceRoots: [root]
  };
  const collected = await collectAllImportedDeclarations(baseSession.ast!, context);
  const session = createAnalysisSession(source, {
    externalDeclarations: collected.externalDeclarations,
    importedSymbols: collected.importedSymbols,
    invalidImportedBindings: collected.invalidImportedBindings,
    ambientDeclarations: domProgram.body,
    ambientDeclarationLocations
  });

  return { context, domPath, domSource, preactPath, preactSource, session };
}

describe("JSX editor features", () => {
  it("provides hover and definitions for intrinsic tags and attributes", async () => {
    const tagCursor = sourceWithCursor(dedent`
      import { render } from "preact"

      function App() {
        return <but^^^ton onClick={event => event.currentTarget}>Add</button>
      }
    `);
    const tagSetup = await createPreactJsxSession(tagCursor.source);
    const tagHover = await resolveHoverWithLocalFallback({
      ...tagSetup.context,
      line: tagCursor.line,
      character: tagCursor.character,
      session: tagSetup.session
    });
    const tagDefinition = await resolveDefinitionWithLocalFallback({
      ...tagSetup.context,
      line: tagCursor.line,
      character: tagCursor.character,
      session: tagSetup.session
    });

    expect((tagHover?.contents as { value?: string } | undefined)?.value).toContain("HTMLButtonElement");
    expect(tagDefinition?.uri).toBe(pathToFileURL(tagSetup.domPath).toString());
    expect(tagDefinition?.range.start.line).toBe(
      tagSetup.domSource.split("\n").findIndex((line) => line.includes("interface HTMLButtonElement"))
    );

    const attributeCursor = sourceWithCursor(tagCursor.source.replace("button onClick", "button onC^^^lick"));
    const attributeSetup = await createPreactJsxSession(attributeCursor.source);
    const attributeHover = await resolveHoverWithLocalFallback({
      ...attributeSetup.context,
      line: attributeCursor.line,
      character: attributeCursor.character,
      session: attributeSetup.session
    });
    const attributeDefinition = await resolveDefinitionWithLocalFallback({
      ...attributeSetup.context,
      line: attributeCursor.line,
      character: attributeCursor.character,
      session: attributeSetup.session
    });

    expect((attributeHover?.contents as { value?: string } | undefined)?.value).toContain("onClick");
    expect((attributeHover?.contents as { value?: string } | undefined)?.value).toContain("HTMLButtonElement");
    expect(attributeDefinition?.uri).toBe(pathToFileURL(attributeSetup.preactPath).toString());
    expect(attributeDefinition?.range.start.line).toBe(
      attributeSetup.preactSource.split("\n").findIndex((line) => line.includes("onClick?:"))
    );

    const memberCursor = sourceWithCursor(tagCursor.source.replace("currentTarget", "currentT^^^arget"));
    const memberSetup = await createPreactJsxSession(memberCursor.source);
    const memberHover = await resolveHoverWithLocalFallback({
      ...memberSetup.context,
      line: memberCursor.line,
      character: memberCursor.character,
      session: memberSetup.session
    });
    const memberDefinition = await resolveDefinitionWithLocalFallback({
      ...memberSetup.context,
      line: memberCursor.line,
      character: memberCursor.character,
      session: memberSetup.session
    });

    expect((memberHover?.contents as { value?: string } | undefined)?.value).toContain("HTMLButtonElement");
    expect(memberDefinition?.uri).toBe(pathToFileURL(memberSetup.preactPath).toString());
    expect(memberDefinition?.range.start.line).toBe(
      memberSetup.preactSource.split("\n").findIndex((line) => line.includes("currentTarget:"))
    );
  });

  it("completes intrinsic tags together with callable component symbols", async () => {
    const intrinsicCursor = sourceWithCursor(dedent`
      import { render } from "preact"

      function Counter() {
        return <div />
      }

      function App() {
        return <bu^^^ />
      }
    `);
    const intrinsicSetup = await createPreactJsxSession(intrinsicCursor.source);
    const intrinsicItems = await createCompletionItemsForPosition(
      intrinsicSetup.session.ast!,
      intrinsicCursor.line,
      intrinsicCursor.character,
      intrinsicSetup.session.analysis,
      [],
      { text: intrinsicCursor.source, ...intrinsicSetup.context }
    );
    const intrinsicByLabel = new Map(intrinsicItems.map((item) => [item.label, item]));

    expect(intrinsicByLabel.get("button")?.detail).toContain("HTMLButtonElement");

    const componentCursor = sourceWithCursor(intrinsicCursor.source.replace("<bu />", "<Co^^^ />"));
    const componentSetup = await createPreactJsxSession(componentCursor.source);
    const componentItems = await createCompletionItemsForPosition(
      componentSetup.session.ast!,
      componentCursor.line,
      componentCursor.character,
      componentSetup.session.analysis,
      [],
      { text: componentCursor.source, ...componentSetup.context }
    );
    const componentByLabel = new Map(componentItems.map((item) => [item.label, item]));

    expect(componentByLabel.get("Counter")?.kind).toBe(3);
    expect(componentByLabel.get("Counter")?.insertText ?? "Counter").toBe("Counter");
  });
});
