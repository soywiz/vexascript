import { defineConfig } from "vite";
import path from "path";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

export default defineConfig({
  resolve: {
    alias: [
      // Browser stub replaces the file-system-dependent ecmascript declarations.
      {
        find: "compiler/runtime/ecmascriptDeclarations",
        replacement: path.resolve(
          __dirname,
          "src/browser-stubs/ecmascriptDeclarations.ts"
        ),
      },
      // Map compiler/* paths to the actual TypeScript source tree.
      {
        find: /^compiler\/(.*)/,
        replacement: path.resolve(__dirname, "../../compiler/$1"),
      },
      // Redirect the Node.js LSP transport to the browser transport.
      {
        find: "vscode-languageserver/node.js",
        replacement: "vscode-languageserver/browser",
      },
      // Browser stubs for Node.js built-ins used by LSP cross-file modules.
      {
        find: "node:path",
        replacement: path.resolve(__dirname, "src/browser-stubs/node-path.ts"),
      },
      {
        find: "node:url",
        replacement: path.resolve(__dirname, "src/browser-stubs/node-url.ts"),
      },
      {
        find: "node:fs/promises",
        replacement: path.resolve(__dirname, "src/browser-stubs/node-fs-promises.ts"),
      },
      {
        find: "node:fs",
        replacement: path.resolve(__dirname, "src/browser-stubs/node-fs-promises.ts"),
      },
    ],
  },
  server: {
    port: 5173,
  },
  optimizeDeps: {
    include: ["monaco-editor"],
    exclude: ["vscode-languageserver", "vscode-languageserver-textdocument"],
  },
  build: {
    target: "es2020",
    rollupOptions: {
      output: {
        manualChunks: {
          "monaco-editor": ["monaco-editor"],
        },
      },
    },
  },
  worker: {
    format: "es",
  },
});
