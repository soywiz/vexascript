function scanJson(source) {
  const tokens = [];
  let offset = 0;

  function skipTrivia() {
    while (offset < source.length) {
      if (/\s/.test(source[offset])) {
        offset += 1;
        continue;
      }
      if (source.startsWith("//", offset)) {
        const lineEnd = source.indexOf("\n", offset + 2);
        offset = lineEnd < 0 ? source.length : lineEnd + 1;
        continue;
      }
      if (source.startsWith("/*", offset)) {
        const commentEnd = source.indexOf("*/", offset + 2);
        offset = commentEnd < 0 ? source.length : commentEnd + 2;
        continue;
      }
      break;
    }
  }

  while (offset < source.length) {
    skipTrivia();
    if (offset >= source.length) {
      break;
    }

    const start = offset;
    const character = source[offset];
    if ("{}[]:,".includes(character)) {
      tokens.push({ type: character, start, end: start + 1 });
      offset += 1;
      continue;
    }

    if (character === '"') {
      offset += 1;
      let escaped = false;
      while (offset < source.length) {
        const current = source[offset];
        offset += 1;
        if (escaped) {
          escaped = false;
        } else if (current === "\\") {
          escaped = true;
        } else if (current === '"') {
          break;
        }
      }
      const raw = source.slice(start, offset);
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw.slice(1, raw.endsWith('"') ? -1 : undefined);
      }
      tokens.push({ type: "string", start, end: offset, value });
      continue;
    }

    while (offset < source.length && !/[\s{}[\]:,]/.test(source[offset])) {
      offset += 1;
    }
    tokens.push({ type: "value", start, end: offset });
  }

  return tokens;
}

function collectJsonProperties(source) {
  const tokens = scanJson(source);
  const properties = [];
  let tokenIndex = 0;

  function peek() {
    return tokens[tokenIndex];
  }

  function consume(type) {
    const token = peek();
    if (!token || (type && token.type !== type)) {
      return undefined;
    }
    tokenIndex += 1;
    return token;
  }

  function parseValue(path) {
    const token = peek();
    if (!token) {
      return;
    }
    if (token.type === "{") {
      parseObject(path);
      return;
    }
    if (token.type === "[") {
      parseArray(path);
      return;
    }
    tokenIndex += 1;
  }

  function parseObject(path) {
    consume("{");
    while (peek() && peek().type !== "}") {
      const key = consume("string");
      if (!key) {
        tokenIndex += 1;
        continue;
      }
      const propertyPath = [...path, key.value];
      properties.push({
        path: propertyPath,
        start: key.start,
        end: key.end
      });
      if (consume(":")) {
        parseValue(propertyPath);
      }
      consume(",");
    }
    consume("}");
  }

  function parseArray(path) {
    consume("[");
    let itemIndex = 0;
    while (peek() && peek().type !== "]") {
      parseValue([...path, itemIndex]);
      itemIndex += 1;
      if (!consume(",") && peek()?.type !== "]") {
        tokenIndex += 1;
      }
    }
    consume("]");
  }

  parseValue([]);
  return properties;
}

function pathsEqual(left, right) {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function findJsonPropertyPathAtOffset(source, offset) {
  return collectJsonProperties(source).find(
    (property) => offset >= property.start && offset <= property.end
  )?.path;
}

function findJsonPropertyRangeAtPath(source, path) {
  const property = collectJsonProperties(source).find((candidate) => pathsEqual(candidate.path, path));
  return property ? { start: property.start, end: property.end } : undefined;
}

const TOP_LEVEL_PROPERTIES = new Set([
  "entrypoint",
  "outDir",
  "outputDir",
  "compilerOptions",
  "canonicalSyntax",
  "importMappings",
  "imports",
  "nativeImports",
  "globalSymbols",
  "serveMappings"
]);
const COMPILER_PROPERTIES = new Set([
  "lib",
  "types",
  "baseUrl",
  "jsxFactory",
  "jsxFragmentFactory",
  "jsxImportSource"
]);
const CANONICAL_SYNTAX_PROPERTIES = new Set([
  "immutableDeclaration",
  "functionDeclaration"
]);
const GLOBAL_SYMBOL_PROPERTIES = new Set(["paths", "files", "include", "emit"]);
const MAPPING_PROPERTIES = new Set(["importMappings", "imports", "nativeImports"]);

function configSchemaPathForProperty(configPath) {
  const [topLevel, nested, itemProperty] = configPath;
  if (typeof topLevel !== "string" || !TOP_LEVEL_PROPERTIES.has(topLevel)) {
    return undefined;
  }
  if (configPath.length === 1) {
    return ["properties", topLevel];
  }
  if (topLevel === "compilerOptions" && typeof nested === "string" && COMPILER_PROPERTIES.has(nested)) {
    return ["properties", topLevel, "properties", nested];
  }
  if (topLevel === "canonicalSyntax" && typeof nested === "string" && CANONICAL_SYNTAX_PROPERTIES.has(nested)) {
    return ["properties", topLevel, "properties", nested];
  }
  if (MAPPING_PROPERTIES.has(topLevel) && typeof nested === "string") {
    return ["properties", topLevel, "additionalProperties"];
  }
  if (topLevel === "globalSymbols" && typeof nested === "string" && GLOBAL_SYMBOL_PROPERTIES.has(nested)) {
    return ["properties", topLevel, "oneOf", 1, "properties", nested];
  }
  if (topLevel === "serveMappings") {
    if (typeof nested === "string") {
      return ["properties", topLevel, "oneOf", 0, "additionalProperties"];
    }
    if (typeof nested === "number" && (itemProperty === "from" || itemProperty === "to")) {
      return ["properties", topLevel, "oneOf", 1, "items", "properties", itemProperty];
    }
  }
  return undefined;
}

function findConfigSchemaDefinition(configSource, offset, schemaSource) {
  const configPath = findJsonPropertyPathAtOffset(configSource, offset);
  if (!configPath) {
    return undefined;
  }
  const schemaPath = configSchemaPathForProperty(configPath);
  if (!schemaPath) {
    return undefined;
  }
  const range = findJsonPropertyRangeAtPath(schemaSource, schemaPath);
  return range ? { range, schemaPath } : undefined;
}

module.exports = {
  configSchemaPathForProperty,
  findConfigSchemaDefinition,
  findJsonPropertyPathAtOffset,
  findJsonPropertyRangeAtPath
};
