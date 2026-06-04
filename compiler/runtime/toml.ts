export type TomlValue = string | string[];
export type TomlSection = Record<string, TomlValue>;
export type TomlDocument = Record<string, TomlSection>;

export function parseToml(source: string): TomlDocument {
  const doc: TomlDocument = {};
  let currentSection = "";

  for (const rawLine of source.split("\n")) {
    const line = rawLine.split("#")[0]!.trim();
    if (line === "") continue;

    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      currentSection = sectionMatch[1]!.trim();
      doc[currentSection] ??= {};
      continue;
    }

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    const rawValue = line.slice(eqIndex + 1).trim();

    const section = currentSection === "" ? (doc[""] ??= {}) : (doc[currentSection] ??= {});
    section[key] = parseValue(rawValue);
  }

  return doc;
}

function parseValue(raw: string): TomlValue {
  if (raw.startsWith("[")) {
    return parseArray(raw);
  }
  return parseString(raw);
}

function parseString(raw: string): string {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function parseArray(raw: string): string[] {
  const inner = raw.slice(1, raw.lastIndexOf("]"));
  const result: string[] = [];
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === '"' || ch === "'") {
      const end = inner.indexOf(ch, i + 1);
      if (end !== -1) {
        result.push(inner.slice(i + 1, end));
        i = end + 1;
      } else {
        i++;
      }
    } else if (ch === "," || ch === " " || ch === "\t") {
      i++;
    } else {
      const comma = inner.indexOf(",", i);
      const token = (comma === -1 ? inner.slice(i) : inner.slice(i, comma)).trim();
      if (token !== "") result.push(token);
      i = comma === -1 ? inner.length : comma + 1;
    }
  }
  return result;
}
