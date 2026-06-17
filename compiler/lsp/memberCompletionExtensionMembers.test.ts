import { describe, expect, it } from "../test/expect";
import dedent from "compiler/utils/dedent";
import { Vfs } from "compiler/vfs";
import { createAnalysisSession } from "./analysisSession";
import {
  buildExtensionMemberCompletionItems,
  collectAvailableExtensionMembers,
  resolveExtensionMemberTypeName
} from "./memberCompletionExtensionMembers";

describe("memberCompletionExtensionMembers", () => {
  it("collects local extension properties and methods for the receiver type", async () => {
    const session = createAnalysisSession(dedent`
      val number.seconds: number => this * 1000
      fun number.clamp(min: number, max: number): number { return this }
    `);

    const members = await collectAvailableExtensionMembers(session.ast!, "number", {});

    expect(members).toEqual([
      {
        kind: "property",
        name: "seconds",
        receiverType: "number",
        returnTypeName: "number"
      },
      {
        kind: "method",
        name: "clamp",
        receiverType: "number",
        returnTypeName: "number"
      }
    ]);
  });

  it("resolves imported extension return types and completion items", async () => {
    const entryPath = "/workspace/main.vx";
    const durationPath = "/workspace/duration.vx";
    const durationSource = dedent`
      export val number.seconds: number => this * 1000
      export fun number.clamp(min: number, max: number): number { return this }
    `;
    const entrySource = dedent`
      import { seconds, clamp } from "./duration"
      fun demo() {
        1.
      }
    `;
    const entrySession = createAnalysisSession(entrySource);
    const durationSession = createAnalysisSession(durationSource);
    const getSessionForFilePath = async (filePath: string) => {
      if (filePath === durationPath) {
        return durationSession;
      }
      if (filePath === entryPath) {
        return entrySession;
      }
      return null;
    };
    class TestVfs extends Vfs {
      override async readFile(filePath: string): Promise<string> {
        if (filePath === entryPath) {
          return entrySource;
        }
        if (filePath === durationPath) {
          return durationSource;
        }
        throw new Error(`Unexpected file read: ${filePath}`);
      }

      override async stat(filePath: string) {
        if (filePath === entryPath || filePath === durationPath) {
          return { mtimeMs: 0, isFile: true, isDirectory: false };
        }
        throw new Error(`Unexpected stat: ${filePath}`);
      }

      override async writeFile(): Promise<void> {
        throw new Error("Not implemented in test");
      }

      override async unlink(): Promise<void> {
        throw new Error("Not implemented in test");
      }

      override async readDir(): Promise<[]> {
        return [];
      }
    }
    const options = {
      uri: "file:///workspace/main.vx",
      getSessionForFilePath,
      vfs: new TestVfs()
    };

    expect(await resolveExtensionMemberTypeName(
      entrySession.ast!,
      "number",
      "seconds",
      options,
      entrySession.analysis
    )).toBe("number");

    const items = await buildExtensionMemberCompletionItems(
      entrySession.ast!,
      "number",
      "",
      options,
      entrySession.analysis
    );
    const byLabel = new Map(items.map((item) => [item.label, item]));

    expect(byLabel.get("seconds")?.detail).toBe("Extension property: number");
    expect(byLabel.get("clamp")?.detail).toBe("Extension method: number");
  });
});
