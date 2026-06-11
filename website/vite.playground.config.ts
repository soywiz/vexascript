import { defineConfig } from "vite";
import { resolve } from "node:path";

const monacoEditorPackagePath = resolve(__dirname, "node_modules/monaco-editor");

export default defineConfig({
  root: resolve(__dirname, "../plugins/monaco"),
  publicDir: false,
  build: {
    emptyOutDir: false,
    outDir: resolve(__dirname, "src/assets/generated/playground"),
    target: "es2020",
    rollupOptions: {
      output: {
        manualChunks: {
          "monaco-editor": ["monaco-editor"],
        },
      },
    },
  },
  resolve: {
    alias: [
      {
        find: "monaco-editor",
        replacement: monacoEditorPackagePath,
      },
      {
        find: "compiler/runtime/ecmascriptDeclarations",
        replacement: resolve(__dirname, "../plugins/monaco/src/browser-stubs/ecmascriptDeclarations.ts"),
      },
      {
        find: /^compiler\/(.*)/,
        replacement: resolve(__dirname, "../compiler/$1"),
      },
      {
        find: "vscode-languageserver/node.js",
        replacement: "vscode-languageserver/browser",
      },
      {
        find: "node:path",
        replacement: resolve(__dirname, "../plugins/monaco/src/browser-stubs/node-path.ts"),
      },
      {
        find: "node:url",
        replacement: resolve(__dirname, "../plugins/monaco/src/browser-stubs/node-url.ts"),
      },
      {
        find: "node:fs/promises",
        replacement: resolve(__dirname, "../plugins/monaco/src/browser-stubs/node-fs-promises.ts"),
      },
      {
        find: "node:fs",
        replacement: resolve(__dirname, "../plugins/monaco/src/browser-stubs/node-fs-promises.ts"),
      },
    ],
  },
  optimizeDeps: {
    include: ["monaco-editor"],
    exclude: ["vscode-languageserver", "vscode-languageserver-textdocument"],
  },
  worker: {
    format: "es",
  },
});
