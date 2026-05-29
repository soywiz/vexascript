import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    mylang: "compiler/cli.ts"
  },
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
  external: ["commander", "vscode-languageserver", "vscode-languageserver-textdocument"],
  banner: {
    js: "#!/usr/bin/env node"
  }
});
