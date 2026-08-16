import { describe, expect, it, join, mkdir, mkdtemp, pathToFileURL, tmpdir, writeFile } from "../test/expect";
import { sourceWithCursor } from "../test/sourceWithCursor";
import dedent from "compiler/utils/dedent";
import { parseSource } from "compiler/pipeline/parse";
import { ObjectLiteral } from "compiler/ast/ast";
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
      export type TargetedEvent<
        Target extends EventTarget = EventTarget,
        TypedEvent extends Event = Event
      > = Omit<TypedEvent, "currentTarget"> & {
        readonly currentTarget: Target
      }
      export interface RefObject<T> {
        current: T | null
      }
      export type RefCallback<T> = (instance: T | null) => void | (() => void)
      export type Ref<T> = RefObject<T> | RefCallback<T> | null
      export type EventHandler<E> = {
        bivarianceHack(event: E): void
      }["bivarianceHack"]
      export type MouseEventHandler<Target extends EventTarget> = EventHandler<TargetedEvent<Target>>
      export interface DOMAttributes<Target extends EventTarget> {
        onClick?: MouseEventHandler<Target> | undefined
        onSubmit?: EventHandler<TargetedEvent<Target>> | undefined
      }
      export interface ButtonHTMLAttributes<Target extends EventTarget> extends DOMAttributes<Target> {}
      export interface MathMathMLAttributes<Target extends EventTarget> {
        display?: Signalish<"block" | "inline" | undefined>
      }
      export type Signalish<T> = T
      export type DOMCSSProperties = {
        [key in keyof Omit<CSSStyleDeclaration, "item">]?: string | number | null | undefined
      }
      export type AllCSSProperties = {
        [key: string]: string | number | null | undefined
      }
      export interface CSSProperties extends AllCSSProperties, DOMCSSProperties {
        cssText?: string | null
      }
      export interface HTMLAttributes<Target extends EventTarget> extends DOMAttributes<Target> {
        onAbort?: (() => void)
        ref?: Ref<Target> | undefined
        style?: CSSProperties
      }
      export interface IntrinsicElements {
        button: ButtonHTMLAttributes<HTMLButtonElement>
        div: HTMLAttributes<HTMLDivElement>
        form: HTMLAttributes<HTMLFormElement>
        header: HTMLAttributes<HTMLElement>
        h1: HTMLAttributes<HTMLElement>
      }
    }

    export interface Context<T> {
      Provider: (props: { value: T; children?: unknown }) => unknown
    }

    export function createContext<T>(defaultValue: T): Context<T>
    export function render(value: unknown, parent: Element): void
  `;
  const domSource = dedent`
    interface EventTarget {}
    interface Event {
      preventDefault(): void
    }
    interface DOMStringMap {
      [name: string]: string | undefined
    }
    interface Element extends EventTarget {}
    interface HTMLElement extends Element {
      dataset: DOMStringMap
    }
    interface HTMLFormElement extends HTMLElement {}
    interface HTMLButtonElement extends HTMLElement {
      click(): void
      disabled: boolean
    }
    interface HTMLDivElement extends HTMLElement {}
    interface CSSStyleDeclaration {
      color: string
      display: string
      gap: string
      overflow: string
    }
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
  if (session.fatalError) {
    throw new Error(session.fatalError);
  }

  return { context, domPath, domSource, preactPath, preactSource, session };
}

describe("JSX editor features", () => {
  it("preserves base Event members through Preact TargetedEvent utility types", async () => {
    const source = dedent`
      import { render } from "preact"

      function App() {
        return <form onSubmit={(event) => event.preventDefault()}></form>
      }
    `;
    const setup = await createPreactJsxSession(source);

    expect(setup.session.semanticIssues.map((issue) => issue.message)).toEqual([]);
  });

  it("contextually types cleanup-capable callback refs from intrinsic JSX attributes", async () => {
    const source = dedent`
      import { render } from "preact"

      function App() {
        return <header ref={(node) => {
          if (node) node.dataset.mounted = "true"
          return () => {}
        }}></header>
      }
    `;
    const setup = await createPreactJsxSession(source);

    expect(setup.session.semanticIssues.map((issue) => issue.message)).toEqual([]);
  });

  it("preserves the concrete target type through implicit JSX event parameters", async () => {
    const cursor = sourceWithCursor(dedent`
      import { render } from "preact"

      function App() {
        return <button onClick={{
          it.currentTarget.cl^^^
        }}>Add</button>
      }
    `);
    const setup = await createPreactJsxSession(cursor.source);
    const items = await createCompletionItemsForPosition(
      setup.session.ast!,
      cursor.line,
      cursor.character,
      setup.session.analysis,
      [],
      { text: cursor.source, ...setup.context }
    );

    expect(items.some((item) => item.label === "click")).toBe(true);
    expect(setup.session.analysis?.getIssues().some((issue) =>
      issue.message.includes("on type 'unknown'")
    )).toBe(false);
  });

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

  it("uses the opening component reference for hover and definition on closing JSX tags", async () => {
    const openingCursor = sourceWithCursor(dedent`
      import { createContext, render } from "preact"

      const CounterContext = createContext(0)

      function App() {
        return <CounterContext.Pro^^^vider value={0}></CounterContext.Provider>
      }
    `);
    const openingSetup = await createPreactJsxSession(openingCursor.source);
    const openingHover = await resolveHoverWithLocalFallback({
      ...openingSetup.context,
      line: openingCursor.line,
      character: openingCursor.character,
      session: openingSetup.session
    });
    const openingDefinition = await resolveDefinitionWithLocalFallback({
      ...openingSetup.context,
      line: openingCursor.line,
      character: openingCursor.character,
      session: openingSetup.session
    });

    const closingCursor = sourceWithCursor(openingCursor.source.replace(
      "</CounterContext.Provider>",
      "</CounterContext.Pro^^^vider>"
    ));
    const closingSetup = await createPreactJsxSession(closingCursor.source);
    const closingHover = await resolveHoverWithLocalFallback({
      ...closingSetup.context,
      line: closingCursor.line,
      character: closingCursor.character,
      session: closingSetup.session
    });
    const closingDefinition = await resolveDefinitionWithLocalFallback({
      ...closingSetup.context,
      line: closingCursor.line,
      character: closingCursor.character,
      session: closingSetup.session
    });

    expect((openingHover?.contents as { value?: string } | undefined)?.value).toContain("Provider");
    expect(openingDefinition?.uri).toBe(pathToFileURL(openingSetup.preactPath).toString());
    expect(openingDefinition?.range.start.line).toBe(
      openingSetup.preactSource.split("\n").findIndex((line) => line.includes("Provider:"))
    );
    expect((closingHover?.contents as { value?: string } | undefined)?.value).toBe(
      (openingHover?.contents as { value?: string } | undefined)?.value
    );
    expect((closingHover?.contents as { value?: string } | undefined)?.value).not.toContain("JSX.Element");
    expect(closingDefinition?.uri).toBe(pathToFileURL(closingSetup.preactPath).toString());
    expect(closingDefinition?.range).toEqual(openingDefinition?.range);
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

  it("completes intrinsic JSX tags immediately after the opening angle bracket", async () => {
    const cursor = sourceWithCursor(dedent`
      import { render } from "preact"

      function App() {
        return <^^^div />
      }
    `);
    const setup = await createPreactJsxSession(cursor.source);
    const items = await createCompletionItemsForPosition(
      setup.session.ast!,
      cursor.line,
      cursor.character,
      setup.session.analysis,
      [],
      { text: cursor.source, ...setup.context }
    );
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.get("div")?.textEdit).toEqual({
      range: {
        start: { line: cursor.line, character: cursor.character },
        end: { line: cursor.line, character: cursor.character }
      },
      newText: "div"
    });
    expect(byLabel.has("h1")).toBe(true);
  });

  it("completes available JSX component attributes as expression snippets", async () => {
    const cursor = sourceWithCursor(dedent`
      import { render } from "preact"

      function Counter({ count: int, increment: () => void }) {
        return <button onClick={increment}>{count}</button>
      }

      function App() {
        return <Counter co^^^ />
      }
    `);
    const setup = await createPreactJsxSession(cursor.source);
    const items = await createCompletionItemsForPosition(
      setup.session.ast!,
      cursor.line,
      cursor.character,
      setup.session.analysis,
      [],
      { text: cursor.source, ...setup.context }
    );
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.has("count")).toBe(true);
    expect(byLabel.has("increment")).toBe(false);
    expect(byLabel.has("render")).toBe(false);
    expect(byLabel.get("count")?.insertTextFormat).toBe(2);
    expect(byLabel.get("count")?.textEdit).toEqual({
      range: {
        start: { line: cursor.line, character: cursor.character - 2 },
        end: { line: cursor.line, character: cursor.character }
      },
      newText: "count={$1}"
    });

    const remainingCursor = sourceWithCursor(cursor.source.replace(
      "<Counter co />",
      "<Counter count={0} ^^^/>"
    ));
    const remainingSetup = await createPreactJsxSession(remainingCursor.source);
    const remainingItems = await createCompletionItemsForPosition(
      remainingSetup.session.ast!,
      remainingCursor.line,
      remainingCursor.character,
      remainingSetup.session.analysis,
      [],
      { text: remainingCursor.source, ...remainingSetup.context }
    );
    const remainingByLabel = new Map(remainingItems.map((item) => [item.label, item]));

    expect(remainingByLabel.has("count")).toBe(false);
    expect(remainingByLabel.get("increment")?.textEdit).toMatchObject({
      newText: "increment={$1}"
    });

    const intrinsicCursor = sourceWithCursor(cursor.source.replace("<Counter co />", "<div ^^^/>"));
    const intrinsicSetup = await createPreactJsxSession(intrinsicCursor.source);
    const intrinsicItems = await createCompletionItemsForPosition(
      intrinsicSetup.session.ast!,
      intrinsicCursor.line,
      intrinsicCursor.character,
      intrinsicSetup.session.analysis,
      [],
      { text: intrinsicCursor.source, triggerCharacter: " ", ...intrinsicSetup.context }
    );
    const intrinsicByLabel = new Map(intrinsicItems.map((item) => [item.label, item]));

    expect(intrinsicByLabel.get("style")?.textEdit).toMatchObject({
      newText: "style={$1}"
    });

  });

  it("completes contextual style properties inside JSX object literals", async () => {
    const cursor = sourceWithCursor(dedent`
      import { render } from "preact"

      function App() {
        const count = 1
        return <div onAbort={} style={{ display: "flex", gap: "20px",^^^ }} />
      }
    `);
    const setup = await createPreactJsxSession(cursor.source);
    expect(setup.session.analysis?.getIssues()).toEqual([]);
    expect(setup.session.analysis?.getJsxAttributeExpectedTypeAt(cursor.line, cursor.character)).not.toBe(null);
    const items = await createCompletionItemsForPosition(
      setup.session.ast!,
      cursor.line,
      cursor.character,
      setup.session.analysis,
      [],
      { text: cursor.source, triggerCharacter: ",", ...setup.context }
    );
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.get("color")?.insertText).toBe("color: ");
    expect(byLabel.has("display")).toBe(false);
    expect(byLabel.has("gap")).toBe(false);
    expect(byLabel.has("count")).toBe(false);
    expect(byLabel.has("render")).toBe(false);

    const continuedCursor = sourceWithCursor(dedent`
      import { render } from "preact"

      function App() {
        return <div style={{ display: "flex", ^^^ }} />
      }
    `);
    const continuedSetup = await createPreactJsxSession(continuedCursor.source);
    const continuedItems = await createCompletionItemsForPosition(
      continuedSetup.session.ast!,
      continuedCursor.line,
      continuedCursor.character,
      continuedSetup.session.analysis,
      [],
      { text: continuedCursor.source, triggerCharacter: " ", ...continuedSetup.context }
    );

    expect(continuedItems.some((item) => item.label === "gap")).toBe(true);

    const emptyCursor = sourceWithCursor(dedent`
      import { render } from "preact"

      function App() {
        const count = 1
        return <div onAbort={} style={{ ^^^ }} />
      }
    `);
    const emptySetup = await createPreactJsxSession(emptyCursor.source);
    const emptyItems = await createCompletionItemsForPosition(
      emptySetup.session.ast!,
      emptyCursor.line,
      emptyCursor.character,
      emptySetup.session.analysis,
      [],
      { text: emptyCursor.source, ...emptySetup.context }
    );
    const emptyByLabel = new Map(emptyItems.map((item) => [item.label, item]));
    const emptyLabels = new Set(emptyByLabel.keys());

    expect(emptyLabels.has("color")).toBe(true);
    expect(emptyLabels.has("display")).toBe(true);
    expect(emptyLabels.has("gap")).toBe(true);
    expect(emptyLabels.has("count")).toBe(false);
    expect(emptyByLabel.get("display")?.detail).toBe(
      "Object property: string | number | null | undefined"
    );
  });

  it("provides type-driven hover and definitions for mapped contextual style properties", async () => {
    const cursor = sourceWithCursor(dedent`
      import { render } from "preact"

      function App() {
        return <div style={{ over^^^flow: "hidden", gap: "20px" }} />
      }
    `);
    const setup = await createPreactJsxSession(cursor.source);
    const objectLiteral = [...(setup.session.analysis?.getExpressionTypes().keys() ?? [])].find(
      (node) => node instanceof ObjectLiteral
    ) as ObjectLiteral | undefined;
    expect(objectLiteral).not.toBe(undefined);
    expect(
      objectLiteral
        ? setup.session.analysis?.getContextualObjectLiteralPropertyOwnerTypeName(objectLiteral, "overflow")
        : null
    ).toBe("CSSStyleDeclaration");
    const hover = await resolveHoverWithLocalFallback({
      ...setup.context,
      line: cursor.line,
      character: cursor.character,
      session: setup.session
    });
    const definition = await resolveDefinitionWithLocalFallback({
      ...setup.context,
      line: cursor.line,
      character: cursor.character,
      session: setup.session
    });

    expect((hover?.contents as { value?: string } | undefined)?.value).toBe(
      "```typescript\noverflow: string | number | null | undefined\n```"
    );
    expect(definition?.uri).toBe(pathToFileURL(setup.domPath).toString());
    expect(definition?.range.start.line).toBe(
      setup.domSource.split("\n").findIndex((line) => line.includes("overflow: string"))
    );
  });

  it("does not invent values for open JSX style property types", async () => {
    const cursor = sourceWithCursor(dedent`
      import { render } from "preact"

      function App() {
        return <div style={{ display: "^^^" }} />
      }
    `);
    const setup = await createPreactJsxSession(cursor.source);
    const items = await createCompletionItemsForPosition(
      setup.session.ast!,
      cursor.line,
      cursor.character,
      setup.session.analysis,
      [],
      { text: cursor.source, ...setup.context }
    );
    expect(setup.session.analysis?.getIssues()).toEqual([]);
    expect(items).toEqual([]);
  });

  it("derives JSX style value completion from declared literal types", async () => {
    const cursor = sourceWithCursor(dedent`
      import { render } from "preact"

      interface PanelStyle {
        overflow?: "visible" | "hidden" | "clip" | "scroll" | "auto"
      }

      function Panel({ style: PanelStyle }) {
        return <div style={style} />
      }

      function App() {
        return <Panel style={{ overflow: "^^^" }} />
      }
    `);
    const setup = await createPreactJsxSession(cursor.source);
    const items = await createCompletionItemsForPosition(
      setup.session.ast!,
      cursor.line,
      cursor.character,
      setup.session.analysis,
      [],
      { text: cursor.source, ...setup.context }
    );
    const labels = new Set(items.map((item) => item.label));

    expect(labels).toEqual(new Set(["visible", "hidden", "clip", "scroll", "auto"]));
    expect(items.find((item) => item.label === "hidden")?.textEdit).toMatchObject({ newText: "hidden" });
  });
});
