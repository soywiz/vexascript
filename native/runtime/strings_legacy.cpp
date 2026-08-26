#include "runtime.hpp"

namespace vexa {

std::u16string stringHtmlWrap(
    const std::u16string& value,
    const std::u16string& tag,
    const std::u16string& attribute,
    const std::u16string& attributeValue) {
  std::u16string result = u"<" + tag;
  if (!attribute.empty()) {
    result += u" " + attribute + u"=\"";
    for (const char16_t character : attributeValue) result += character == u'\"' ? u"&quot;" : std::u16string(1, character);
    result += u"\"";
  }
  return result + u">" + value + u"</" + tag + u">";
}

std::u16string anchor(const std::u16string& value, const std::u16string& name) { return stringHtmlWrap(value, u"a", u"name", name); }

std::u16string big(const std::u16string& value) { return stringHtmlWrap(value, u"big"); }

std::u16string blink(const std::u16string& value) { return stringHtmlWrap(value, u"blink"); }

std::u16string bold(const std::u16string& value) { return stringHtmlWrap(value, u"b"); }

std::u16string fixed(const std::u16string& value) { return stringHtmlWrap(value, u"tt"); }

std::u16string italics(const std::u16string& value) { return stringHtmlWrap(value, u"i"); }

std::u16string link(const std::u16string& value, const std::u16string& url) { return stringHtmlWrap(value, u"a", u"href", url); }

std::u16string small(const std::u16string& value) { return stringHtmlWrap(value, u"small"); }

std::u16string strike(const std::u16string& value) { return stringHtmlWrap(value, u"strike"); }

std::u16string sub(const std::u16string& value) { return stringHtmlWrap(value, u"sub"); }

std::u16string sup(const std::u16string& value) { return stringHtmlWrap(value, u"sup"); }

double localeCompare(const std::u16string& value, const std::u16string& other) {
  return value < other ? -1 : value > other ? 1 : 0;
}

std::u16string padStart(
    const std::u16string& value,
    double targetLength,
    const std::u16string& fill) {
  const auto target = static_cast<std::size_t>(std::max(0.0, std::trunc(targetLength)));
  if (value.size() >= target || fill.empty()) return value;
  std::u16string prefix;
  while (prefix.size() < target - value.size()) prefix += fill;
  prefix.resize(target - value.size());
  return prefix + value;
}

std::u16string padEnd(
    const std::u16string& value,
    double targetLength,
    const std::u16string& fill) {
  std::u16string result = value;
  const auto target = static_cast<std::size_t>(std::max(0.0, std::trunc(targetLength)));
  if (result.size() >= target || fill.empty()) return result;
  while (result.size() < target) result += fill;
  result.resize(target);
  return result;
}

std::u16string substr(
    const std::u16string& value,
    double start,
    double length) {
  const auto size = static_cast<std::int64_t>(value.size());
  auto first = static_cast<std::int64_t>(std::trunc(start));
  if (first < 0) first = std::max<std::int64_t>(0, size + first);
  first = std::min(first, size);
  const auto count = std::isinf(length)
    ? size - first
    : std::max<std::int64_t>(0, std::min<std::int64_t>(size - first, static_cast<std::int64_t>(std::trunc(length))));
  return value.substr(static_cast<std::size_t>(first), static_cast<std::size_t>(count));
}

std::u16string normalize(
    std::u16string value,
    const std::u16string& form) {
  if (form != u"NFC" && form != u"NFD" && form != u"NFKC" && form != u"NFKD") {
    throw runtimeError(u"Invalid Unicode normalization form");
  }
  static const std::unordered_map<char16_t, std::u16string> canonicalDecomposition = {
    {u'À', u"A\u0300"}, {u'Á', u"A\u0301"}, {u'Â', u"A\u0302"}, {u'Ã', u"A\u0303"},
    {u'Ä', u"A\u0308"}, {u'Å', u"A\u030A"}, {u'Ç', u"C\u0327"}, {u'È', u"E\u0300"},
    {u'É', u"E\u0301"}, {u'Ê', u"E\u0302"}, {u'Ë', u"E\u0308"}, {u'Ì', u"I\u0300"},
    {u'Í', u"I\u0301"}, {u'Î', u"I\u0302"}, {u'Ï', u"I\u0308"}, {u'Ñ', u"N\u0303"},
    {u'Ò', u"O\u0300"}, {u'Ó', u"O\u0301"}, {u'Ô', u"O\u0302"}, {u'Õ', u"O\u0303"},
    {u'Ö', u"O\u0308"}, {u'Ù', u"U\u0300"}, {u'Ú', u"U\u0301"}, {u'Û', u"U\u0302"},
    {u'Ü', u"U\u0308"}, {u'Ý', u"Y\u0301"}, {u'à', u"a\u0300"}, {u'á', u"a\u0301"},
    {u'â', u"a\u0302"}, {u'ã', u"a\u0303"}, {u'ä', u"a\u0308"}, {u'å', u"a\u030A"},
    {u'ç', u"c\u0327"}, {u'è', u"e\u0300"}, {u'é', u"e\u0301"}, {u'ê', u"e\u0302"},
    {u'ë', u"e\u0308"}, {u'ì', u"i\u0300"}, {u'í', u"i\u0301"}, {u'î', u"i\u0302"},
    {u'ï', u"i\u0308"}, {u'ñ', u"n\u0303"}, {u'ò', u"o\u0300"}, {u'ó', u"o\u0301"},
    {u'ô', u"o\u0302"}, {u'õ', u"o\u0303"}, {u'ö', u"o\u0308"}, {u'ù', u"u\u0300"},
    {u'ú', u"u\u0301"}, {u'û', u"u\u0302"}, {u'ü', u"u\u0308"}, {u'ý', u"y\u0301"},
    {u'ÿ', u"y\u0308"},
  };
  const bool compatibility = form == u"NFKC" || form == u"NFKD";
  const bool compose = form == u"NFC" || form == u"NFKC";
  std::u16string decomposed;
  for (const char16_t character : value) {
    const auto canonical = canonicalDecomposition.find(character);
    if (canonical != canonicalDecomposition.end()) decomposed += canonical->second;
    else if (compatibility && character == u'\u00A0') decomposed += u' ';
    else if (compatibility && character == u'\uFB01') decomposed += u"fi";
    else decomposed += character;
  }
  if (!compose) return decomposed;
  std::unordered_map<std::u16string, char16_t> composition;
  for (const auto& [character, sequence] : canonicalDecomposition) composition.emplace(sequence, character);
  std::u16string result;
  for (std::size_t index = 0; index < decomposed.size();) {
    if (index + 1 < decomposed.size()) {
      const auto found = composition.find(decomposed.substr(index, 2));
      if (found != composition.end()) {
        result += found->second;
        index += 2;
        continue;
      }
    }
    result += decomposed[index++];
  }
  return result;
}

std::u16string stringRaw(RecordObject* templateObject, ArrayObject<Value>* substitutions) {
  if (!templateObject) throw runtimeError(u"String.raw requires a template object");
  const Value raw = templateObject->get(u"raw");
  auto* strings = arrayPointer(raw);
  std::u16string result;
  for (std::size_t index = 0; index < strings->size(); ++index) {
    result += toString(strings->get(index));
    if (index < substitutions->size()) result += toString(substitutions->get(index));
  }
  return result;
}

}  // namespace vexa
