import { spawn, type StdioOptions } from "node:child_process";
export { fileExists, isDirectory } from "../compiler/utils/fs";

export interface CommandOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

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

export async function runCommandCapture(
  command: string,
  args: string[],
  options: { cwd?: string } = {}
): Promise<CommandOutput> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function spawnDetached(command: string, args: string[], spawnImpl: typeof spawn = spawn): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawnImpl(command, args, {
      detached: true,
      stdio: "ignore",
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}

export async function openUrlInDefaultBrowser(
  url: string,
  options: {
    browserCommand?: string;
    platform?: NodeJS.Platform;
    spawnImpl?: typeof spawn;
  } = {}
): Promise<void> {
  const browserCommand = options.browserCommand ?? process.env["BROWSER"];
  const platform = options.platform ?? process.platform;
  const spawnImpl = options.spawnImpl ?? spawn;

  if (browserCommand) {
    await spawnDetached(browserCommand, [url], spawnImpl);
    return;
  }

  if (platform === "darwin") {
    await spawnDetached("open", [url], spawnImpl);
    return;
  }

  if (platform === "win32") {
    await spawnDetached("cmd", ["/c", "start", "", url], spawnImpl);
    return;
  }

  await spawnDetached("xdg-open", [url], spawnImpl);
}
