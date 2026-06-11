import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { expect } from "./test/expect";
import { sourceWithCursor } from "./test/sourceWithCursor";
import { VexaMcpCodebaseServer } from "./mcpServer";
import { COMPILER_VERSION } from "./compilerVersion";
import dedent from "compiler/utils/dedent";

function textPayload(result: { content: Array<{ type: "text"; text: string }> }): unknown {
  return JSON.parse(result.content[0]!.text) as unknown;
}

describe("MCP codebase navigation server", () => {
  it("advertises VexaScript navigation tools through JSON-RPC", async () => {
    const server = new VexaMcpCodebaseServer();

    const response = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          { name: "vexa_workspace_symbols" },
          { name: "vexa_document_symbols" },
          { name: "vexa_hover" },
          { name: "vexa_definition" },
          { name: "vexa_references" },
          { name: "vexa_signature_help" },
          { name: "vexa_rename" }
        ]
      }
    });
  });

  it("reports the compiler version from the root package.json during initialize", async () => {
    const server = new VexaMcpCodebaseServer();

    const response = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        serverInfo: {
          name: "vexa",
          version: COMPILER_VERSION
        }
      }
    });
  });

  it("explores symbols and signatures in a workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-mcp-"));
    const main = join(dir, "main.vx");
    const { source, line, character } = sourceWithCursor(dedent`
      fun add(left: int, right: int): int {
        return left + right
      }
      fun demo() {
        return add(1, ^^^2)
      }
    `);
    await writeFile(main, source, "utf8");
    const server = new VexaMcpCodebaseServer(dir);

    const symbols = textPayload(await server.callTool("vexa_workspace_symbols", { root: dir, query: "add" })) as Array<{ name: string }>;
    const signature = textPayload(await server.callTool("vexa_signature_help", {
      file: main,
      line,
      character,
      root: dir
    })) as { signatures: Array<{ label: string }>; activeParameter: number };

    expect(symbols.some((symbol) => symbol.name === "add")).toBe(true);
    expect(signature.signatures[0]?.label).toBe("add(left: int, right: int): int");
    expect(signature.activeParameter).toBe(1);
  });

  it("returns and applies rename edits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vexa-mcp-rename-"));
    const main = join(dir, "main.vx");
    const { source, line, character } = sourceWithCursor(dedent`
      fun greet(name: string): string {
        return name
      }
      let message = gr^^^eet("Ada")
    `);
    await writeFile(main, source, "utf8");
    const server = new VexaMcpCodebaseServer(dir);

    const dryRun = textPayload(await server.callTool("vexa_rename", {
      file: main,
      line,
      character,
      newName: "welcome"
    })) as { edit: { changes: Record<string, unknown[]> } };
    expect(Object.values(dryRun.edit.changes).flat()).toHaveLength(2);

    const applied = textPayload(await server.callTool("vexa_rename", {
      file: main,
      line,
      character,
      newName: "welcome",
      apply: true
    })) as { changedFiles: string[] };
    const updated = await readFile(main, "utf8");

    expect(applied.changedFiles).toEqual([main]);
    expect(updated).toContain("fun welcome(name: string): string");
    expect(updated).toContain('let message = welcome("Ada")');
  });
});
