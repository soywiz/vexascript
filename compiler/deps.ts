import { readFile, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isPackageInstalled(projectDir: string, pkg: string): Promise<boolean> {
  return fileExists(resolve(projectDir, "node_modules", pkg));
}

async function ensurePackageJson(projectDir: string): Promise<void> {
  const pkgPath = resolve(projectDir, "package.json");
  if (!(await fileExists(pkgPath))) {
    await writeFile(pkgPath, JSON.stringify({ type: "module" }, null, 2) + "\n", "utf8");
  }
}

function detectPackageManager(projectDir: string): Promise<"pnpm" | "npm"> {
  return fileExists(resolve(projectDir, "pnpm-lock.yaml")).then((has) => (has ? "pnpm" : "npm"));
}

export async function ensureDependencies(
  projectDir: string,
  dependencies: Record<string, string>
): Promise<void> {
  const pkgs = Object.entries(dependencies);
  if (pkgs.length === 0) return;

  const missing = await Promise.all(
    pkgs.map(async ([pkg]) => ({ pkg, missing: !(await isPackageInstalled(projectDir, pkg)) }))
  );
  const toInstall = missing.filter((x) => x.missing).map((x) => x.pkg);
  if (toInstall.length === 0) return;

  await ensurePackageJson(projectDir);
  const pm = await detectPackageManager(projectDir);

  const specs = toInstall.map((pkg) => {
    const version = dependencies[pkg];
    return version && version !== "*" ? `${pkg}@${version}` : pkg;
  });

  console.log(`Installing dependencies: ${specs.join(", ")}`);
  const args = pm === "pnpm" ? ["add", ...specs] : ["install", ...specs];
  await execFileAsync(pm, args, { cwd: projectDir });
}
