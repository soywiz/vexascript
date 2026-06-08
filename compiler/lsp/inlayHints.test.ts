import { describe, it } from "node:test";
import { expect } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { createAnalysisSession } from "./analysisSession";
import { createInlayHints } from "./inlayHints";

describe("inlay hints", () => {
  it("provides inferred type hints and parameter name hints", async () => {
    const source =
dedent`
      class Box {
        fun size(a: int) {
          return 1
        }
      }
      fun sum(a: int, b: int) {
        return a + b
      }
      `;

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const hints = await createInlayHints(
      session.ast!,
      session.analysis!,
      {
        start: { line: 0, character: 0 },
        end: { line: 20, character: 0 }
      }
    );
    const labels = hints.map((hint) => (typeof hint.label === "string" ? hint.label : ""));
    const returnHints = hints.filter((hint) => hint.label === ": int");
    const lines = source.split("\n");

    expect(labels).toContain(": int");
    expect(returnHints).toContainEqual(
      expect.objectContaining({
        position: {
          line: 5,
          character: lines[5]!.indexOf(")") + 1
        }
      })
    );
  });

  it("provides constructor parameter name hints for new expressions", async () => {
    const source =
dedent`
      class Point(val x: int, val y: int)
      fun demo() {
        const point = new Point(1, 2)
      }
      `;

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const hints = await createInlayHints(
      session.ast!,
      session.analysis!,
      {
        start: { line: 0, character: 0 },
        end: { line: 20, character: 0 }
      }
    );
    const labels = hints.map((hint) => (typeof hint.label === "string" ? hint.label : ""));

    expect(labels).toContain("x: ");
    expect(labels).toContain("y: ");
  });

  it("does not emit parameter hints for arguments already passed by name", async () => {
    const source =
dedent`
      fun connect(host: string, port: number) {}
      fun demo() {
        connect(port: 8080, host: "localhost")
      }
      `;

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const hints = await createInlayHints(
      session.ast!,
      session.analysis!,
      {
        start: { line: 0, character: 0 },
        end: { line: 20, character: 0 }
      }
    );
    const labels = hints.map((hint) => (typeof hint.label === "string" ? hint.label : ""));

    expect(labels).not.toContain("host: ");
    expect(labels).not.toContain("port: ");
  });

  it("emits hints only for positional arguments when mixed with named ones", async () => {
    const source =
dedent`
      fun connect(host: string, port: number) {}
      fun demo() {
        connect("localhost", port: 8080)
      }
      `;

    const session = createAnalysisSession(source);
    expect(session.ast).toBeTruthy();
    expect(session.analysis).toBeTruthy();

    const hints = await createInlayHints(
      session.ast!,
      session.analysis!,
      {
        start: { line: 0, character: 0 },
        end: { line: 20, character: 0 }
      }
    );
    const labels = hints.map((hint) => (typeof hint.label === "string" ? hint.label : ""));

    expect(labels).toContain("host: ");
    expect(labels).not.toContain("port: ");
  });
});
