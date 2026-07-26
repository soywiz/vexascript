const { readFile } = require("node:fs/promises");

const TEXT_MODULE_SUFFIX = "?text";

async function resolve(specifier, context, nextResolve) {
  if (!specifier.endsWith(TEXT_MODULE_SUFFIX)) {
    return nextResolve(specifier, context);
  }
  const sourceSpecifier = specifier.slice(0, -TEXT_MODULE_SUFFIX.length);
  const resolved = await nextResolve(sourceSpecifier, context);
  return {
    ...resolved,
    url: `${resolved.url}${TEXT_MODULE_SUFFIX}`
  };
}

async function load(url, context, nextLoad) {
  if (!url.endsWith(TEXT_MODULE_SUFFIX)) {
    return nextLoad(url, context);
  }
  const sourceUrl = new URL(url.slice(0, -TEXT_MODULE_SUFFIX.length));
  const contents = await readFile(sourceUrl, "utf8");
  return {
    format: "module",
    shortCircuit: true,
    source: `export default ${JSON.stringify(contents)};`
  };
}

module.exports = { load, resolve };
