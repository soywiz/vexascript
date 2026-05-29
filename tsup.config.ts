import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["compiler/cli.ts"],
  outDir: "dist",
  outExtension: () => ({ js: ".js" }),
  format: ["esm"],
  platform: "node",
  target: "node20",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: false,
  noExternal: [/(.*)/],
  banner: {
    js: "#!/usr/bin/env node"
  }
});
