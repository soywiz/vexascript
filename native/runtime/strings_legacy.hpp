#pragma once

// Internal runtime category header. Include runtime.hpp instead.

std::u16string stringHtmlWrap(
    const std::u16string& value,
    const std::u16string& tag,
    const std::u16string& attribute = u"",
    const std::u16string& attributeValue = u"");

std::u16string anchor(const std::u16string& value, const std::u16string& name);
std::u16string big(const std::u16string& value);
std::u16string blink(const std::u16string& value);
std::u16string bold(const std::u16string& value);
std::u16string fixed(const std::u16string& value);
template <typename Color>
inline std::u16string fontcolor(const std::u16string& value, const Color& color) {
  return stringHtmlWrap(value, u"font", u"color", toString(convertValue<Value>(color)));
}
template <typename Size>
inline std::u16string fontsize(const std::u16string& value, const Size& size) {
  return stringHtmlWrap(value, u"font", u"size", toString(convertValue<Value>(size)));
}
std::u16string italics(const std::u16string& value);
std::u16string link(const std::u16string& value, const std::u16string& url);
std::u16string small(const std::u16string& value);
std::u16string strike(const std::u16string& value);
std::u16string sub(const std::u16string& value);
std::u16string sup(const std::u16string& value);

double localeCompare(const std::u16string& value, const std::u16string& other);

std::u16string padStart(
    const std::u16string& value,
    double targetLength,
    const std::u16string& fill = u" ");

std::u16string padEnd(
    const std::u16string& value,
    double targetLength,
    const std::u16string& fill = u" ");

std::u16string substr(
    const std::u16string& value,
    double start,
    double length = std::numeric_limits<double>::infinity());

std::u16string normalize(
    std::u16string value,
    const std::u16string& form = u"NFC");

template <typename... Points>
inline std::u16string stringFromCodePoint(Points... rawPoints) {
  std::u16string result;
  const auto append = [&](double rawPoint) {
    if (!std::isfinite(rawPoint) || std::trunc(rawPoint) != rawPoint || rawPoint < 0 || rawPoint > 0x10ffff) {
      throw runtimeError(u"Invalid Unicode code point");
    }
    const auto point = static_cast<std::uint32_t>(rawPoint);
    if (point <= 0xffff) {
      result.push_back(static_cast<char16_t>(point));
    } else {
      const auto adjusted = point - 0x10000;
      result.push_back(static_cast<char16_t>(0xd800 + (adjusted >> 10U)));
      result.push_back(static_cast<char16_t>(0xdc00 + (adjusted & 0x3ffU)));
    }
  };
  (append(Number(convertValue<Value>(rawPoints))), ...);
  return result;
}

std::u16string stringRaw(RecordObject* templateObject, ArrayObject<Value>* substitutions);
