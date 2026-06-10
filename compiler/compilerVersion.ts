import packageJson from "../package.json";

function readCompilerVersion(version: unknown): string {
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("Root package.json is missing a valid version string");
  }
  return version;
}

export const COMPILER_VERSION = readCompilerVersion(packageJson.version);
