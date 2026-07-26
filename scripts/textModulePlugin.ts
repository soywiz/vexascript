import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Plugin } from "esbuild";

const TEXT_MODULE_SUFFIX = "?text";
const TEXT_MODULE_NAMESPACE = "vexa-text-module";

export function textModulePlugin(): Plugin {
  return {
    name: TEXT_MODULE_NAMESPACE,
    setup(build) {
      build.onResolve({ filter: /\?text$/ }, (args) => {
        const sourceSpecifier = args.path.slice(0, -TEXT_MODULE_SUFFIX.length);
        const sourcePath = isAbsolute(sourceSpecifier)
          ? sourceSpecifier
          : resolve(args.resolveDir, sourceSpecifier);
        return {
          namespace: TEXT_MODULE_NAMESPACE,
          path: sourcePath
        };
      });
      build.onLoad(
        { filter: /.*/, namespace: TEXT_MODULE_NAMESPACE },
        async (args) => ({
          contents: await readFile(args.path, "utf8"),
          loader: "text",
          watchFiles: [args.path]
        })
      );
    }
  };
}
