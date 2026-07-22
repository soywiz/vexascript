import {
  describe,
  expect,
  it,
  join,
  mkdtemp,
  rm,
  tmpdir,
  vi,
  writeFile,
} from "../compiler/test/expect";
import { runCli } from "./cli";
import { runCommandCapture } from "./io";

describe("native foreign libraries", () => {
  it("opens fallback paths, resumes async calls, and reads and writes pointers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-native-ffi-"));
    const sourcePath = join(root, "main.vx");
    const executablePath = join(root, "ffi-smoke");
    const buildRoot = join(root, "build");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await writeFile(sourcePath, [
        '@FFILibrary("__vexa_missing_library__", "libSystem.B.dylib", "libc.so.6", "msvcrt.dll")',
        "declare class NativeC {",
        "  static abs(value: int): Promise<int>",
        "  static malloc(size: long): FFIPointer",
        "  static memset(bytes: ArrayBuffer, value: int, size: long): FFIPointer",
        "  static free(pointer: FFIPointer): void",
        "}",
        "sync function main(): void {",
        "  const value = NativeC.abs(-42)",
        "  const pointer = NativeC.malloc(8L)",
        "  pointer.setInt32(0, 1234)",
        "  const bytes = ArrayBuffer(4)",
        "  NativeC.memset(bytes, 65, 4L)",
        "  const view = DataView(bytes)",
        "  console.log(value, pointer.getInt32(0), view.getUint8(0))",
        "  NativeC.free(pointer)",
        "}",
        "main()",
      ].join("\n"), "utf8");

      await runCli([
        "node",
        "vexa",
        "executable",
        sourcePath,
        "--out",
        executablePath,
        "--build-dir",
        buildRoot,
      ]);
      const result = await runCommandCapture(executablePath, []);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("42 1234 65");
    } finally {
      logSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
