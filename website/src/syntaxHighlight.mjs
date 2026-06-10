import portableLanguage, { mylangPrimitiveTypes } from "./generated/mylang-monarch-language.mjs";

const declarationKeywords = new Set([
  ...portableLanguage.declarationKeywords
]);
const controlKeywords = new Set([
  ...portableLanguage.controlKeywords
]);
const primitiveTypes = new Set(mylangPrimitiveTypes);

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
  if (token === "number.float") {
    return "token-number";
  }
  if (token === "keyword.declaration") {
    return "token-keyword-declaration";
  }
  if (token === "keyword.control") {
    return "token-keyword-control";
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

function resolveCaseToken(text) {
  if (declarationKeywords.has(text)) {
    return "keyword.declaration";
  }
  if (controlKeywords.has(text)) {
    return "keyword.control";
  }
  if (primitiveTypes.has(text)) {
    return "type.primitive";
  }
  return "identifier";
}

function wrapToken(text, token) {
  if (!token) {
    return escapeHtml(text);
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

export function highlightMyLangHtml(source) {
  return highlightWithPortableLanguage(source, portableLanguage);
}

export function renderHighlightedCodeBlock(source, language = "mylang") {
  const normalizedLanguage = language.trim().toLowerCase();
  const html = normalizedLanguage === "mylang"
    ? highlightMyLangHtml(source)
    : escapeHtml(source);
  return `<pre class="syntax-block"><code class="language-${escapeHtml(normalizedLanguage)}">${html}</code></pre>`;
}
