import portableLanguage, { vexaPrimitiveTypes } from "./generated/vexa-monarch-language.mjs";

const declarationKeywords = new Set(portableLanguage.declarationKeywords);
const modifierKeywords = new Set(portableLanguage.modifierKeywords);
const functionKeywords = new Set(portableLanguage.functionKeywords);
const typeKeywords = new Set(portableLanguage.typeKeywords);
const controlKeywords = new Set(portableLanguage.controlKeywords);
const primitiveTypes = new Set(vexaPrimitiveTypes);
const sharedHighlightLanguages = new Set(["vexa", "typescript", "ts", "tsx"]);

const compiledRules = new Map(
  Object.entries(portableLanguage.tokenizer).map(([state, rules]) => [
    state,
    rules.map((rule) => ({
      regex: new RegExp(rule.match, "my"),
      rule
    }))
  ])
);

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function tokenClassName(token) {
  if (token === "identifier") {
    return "token-identifier";
  }
  if (token === "comment.doc") {
    return "token-comment-doc";
  }
  if (token === "comment") {
    return "token-comment";
  }
  if (token === "string") {
    return "token-string";
  }
  if (token === "regexp") {
    return "token-regexp";
  }
  if (token === "number.float") {
    return "token-number";
  }
  if (token === "keyword.declaration") {
    return "token-keyword-declaration";
  }
  if (token === "keyword.control") {
    return "token-keyword-control";
  }
  if (token === "keywordModifier") {
    return "token-keyword-modifier";
  }
  if (token === "keywordFunction") {
    return "token-keyword-function";
  }
  if (token === "keywordType") {
    return "token-keyword-type";
  }
  if (token === "type.primitive") {
    return "token-type-primitive";
  }
  if (token === "annotation") {
    return "token-annotation";
  }
  if (token === "operator") {
    return "token-operator";
  }
  if (token === "delimiter" || token === "delimiter.bracket") {
    return "token-delimiter";
  }
  if (token === "tag") {
    return "token-tag";
  }
  if (token === "attribute.name") {
    return "token-attribute";
  }
  return "token-plain";
}

function regexBodyEnd(value) {
  let inCharacterClass = false;
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "[") {
      inCharacterClass = true;
      continue;
    }
    if (character === "]") {
      inCharacterClass = false;
      continue;
    }
    if (character === "/" && !inCharacterClass) {
      return index;
    }
  }
  return -1;
}

function regexCharacterClassEnd(value, start, bodyEnd) {
  for (let index = start + 1; index < bodyEnd; index += 1) {
    if (value[index] === "\\") {
      index += 1;
      continue;
    }
    if (value[index] === "]") {
      return index + 1;
    }
  }
  return bodyEnd;
}

function wrapRegexPart(text, className) {
  return `<span class="${className}">${escapeHtml(text)}</span>`;
}

function highlightRegularExpression(value) {
  const bodyEnd = regexBodyEnd(value);
  if (bodyEnd <= 1) {
    return wrapRegexPart(value, "token-regexp");
  }

  const output = [wrapRegexPart(value.slice(0, 1), "token-regexp-delimiter")];
  let literalStart = 1;
  const flushLiteral = (end) => {
    if (literalStart < end) {
      output.push(wrapRegexPart(value.slice(literalStart, end), "token-regexp"));
    }
  };

  let index = 1;
  while (index < bodyEnd) {
    const character = value[index];
    if (character === "\\") {
      flushLiteral(index);
      const end = Math.min(index + 2, bodyEnd);
      output.push(wrapRegexPart(value.slice(index, end), "token-regexp-escape"));
      index = end;
      literalStart = index;
      continue;
    }
    if (character === "[") {
      flushLiteral(index);
      const end = regexCharacterClassEnd(value, index, bodyEnd);
      output.push(wrapRegexPart(value.slice(index, end), "token-regexp-character-class"));
      index = end;
      literalStart = index;
      continue;
    }
    if ("^$*+?.()|{}".includes(character)) {
      flushLiteral(index);
      output.push(wrapRegexPart(character, "token-regexp-special"));
      index += 1;
      literalStart = index;
      continue;
    }
    index += 1;
  }

  flushLiteral(bodyEnd);
  output.push(wrapRegexPart(value.slice(bodyEnd, bodyEnd + 1), "token-regexp-delimiter"));
  if (bodyEnd + 1 < value.length) {
    output.push(wrapRegexPart(value.slice(bodyEnd + 1), "token-regexp-flag"));
  }
  return output.join("");
}

function resolveCaseToken(text) {
  if (modifierKeywords.has(text)) return "keywordModifier";
  if (functionKeywords.has(text)) return "keywordFunction";
  if (typeKeywords.has(text)) return "keywordType";
  if (declarationKeywords.has(text)) return "keyword.declaration";
  if (controlKeywords.has(text)) return "keyword.control";
  if (primitiveTypes.has(text)) return "type.primitive";
  return "identifier";
}

function wrapToken(text, token) {
  if (!token) {
    return escapeHtml(text);
  }
  if (token === "regexp") {
    return highlightRegularExpression(text);
  }
  const className = tokenClassName(token);
  if (className === "token-plain") {
    return escapeHtml(text);
  }
  return `<span class="${className}">${escapeHtml(text)}</span>`;
}

function applyStateTransition(stateStack, rule) {
  if (rule.switchTo) {
    stateStack[stateStack.length - 1] = rule.switchTo.replace(/^@/, "");
    return;
  }
  if (!rule.next) {
    return;
  }
  if (rule.next === "@pop") {
    if (stateStack.length > 1) {
      stateStack.pop();
    }
    return;
  }
  stateStack.push(rule.next.replace(/^@/, ""));
}

function highlightWithPortableLanguage(source, language) {
  const output = [];
  const stateStack = ["root"];
  let index = 0;

  while (index < source.length) {
    const state = stateStack[stateStack.length - 1] ?? "root";
    const rules = compiledRules.get(state) ?? compiledRules.get("root") ?? [];
    let matched = false;

    for (const { regex, rule } of rules) {
      regex.lastIndex = index;
      const match = regex.exec(source);
      if (!match || match.index !== index) {
        continue;
      }

      const text = match[0] ?? "";
      if (text.length === 0) {
        continue;
      }

      const token = rule.token === "@cases"
        ? resolveCaseToken(text)
        : rule.token;
      output.push(wrapToken(text, token));
      applyStateTransition(stateStack, rule);
      index += text.length;
      matched = true;
      break;
    }

    if (!matched) {
      output.push(escapeHtml(source[index] ?? ""));
      index += 1;
    }
  }

  return output.join("");
}

export function highlightVexaScriptHtml(source) {
  return highlightWithPortableLanguage(source, portableLanguage);
}

export function renderHighlightedCodeBlock(source, language = "vexa") {
  const normalizedLanguage = language.trim().toLowerCase();
  const html = sharedHighlightLanguages.has(normalizedLanguage)
    ? highlightVexaScriptHtml(source)
    : escapeHtml(source);
  return `<pre class="syntax-block"><code class="language-${escapeHtml(normalizedLanguage)}">${html}</code></pre>`;
}
