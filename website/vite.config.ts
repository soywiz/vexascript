import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  base: "/assets/generated/",
  root: __dirname,
  publicDir: false,
  build: {
    emptyOutDir: true,
    outDir: resolve(__dirname, "src/assets/generated"),
    lib: {
      entry: resolve(__dirname, "src/assets/mylang-embed.ts"),
      name: "MyLangEmbeds",
      formats: ["iife"],
      fileName: () => "mylang-embed.js"
    },
    rollupOptions: {
      output: {
        assetFileNames: "[name][extname]"
      }
    }
  },
  resolve: {
    alias: [
      {
        find: "compiler/runtime/ecmascriptDeclarations",
        replacement: resolve(__dirname, "../plugins/monaco/src/browser-stubs/ecmascriptDeclarations.ts")
      },
      {
        find: "vscode-languageserver/node.js",
        replacement: "vscode-languageserver/browser"
      },
      {
        find: "node:path",
        replacement: resolve(__dirname, "../plugins/monaco/src/browser-stubs/node-path.ts")
      },
      {
        find: "node:url",
        replacement: resolve(__dirname, "../plugins/monaco/src/browser-stubs/node-url.ts")
      },
      {
        find: "node:fs/promises",
        replacement: resolve(__dirname, "../plugins/monaco/src/browser-stubs/node-fs-promises.ts")
      },
      {
        find: "node:fs",
        replacement: resolve(__dirname, "../plugins/monaco/src/browser-stubs/node-fs-promises.ts")
      },
      {
        find: /^compiler\/(.*)/,
        replacement: resolve(__dirname, "../compiler/$1")
      }
    ]
  }
});
