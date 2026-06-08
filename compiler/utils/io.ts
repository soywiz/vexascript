import { spawn, type StdioOptions } from "node:child_process";
export { fileExists, isDirectory } from "./fs";

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; stdio?: StdioOptions } = {}
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: options.stdio ?? "inherit",
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}
