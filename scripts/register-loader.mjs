import { register } from "module";
import { pathToFileURL } from "url";
import { resolve } from "path";

register(
  pathToFileURL(resolve(process.cwd(), "scripts/loader.mjs")).href,
  { parentURL: pathToFileURL(process.cwd() + "/").href }
);
