#pragma once

// Internal runtime category header. Include runtime.hpp instead.

inline int uriHexValue(char16_t value) {
  if (value >= u'0' && value <= u'9') return value - u'0';
  if (value >= u'a' && value <= u'f') return value - u'a' + 10;
  if (value >= u'A' && value <= u'F') return value - u'A' + 10;
  return -1;
}

inline std::u16string decodeUriComponentText(const std::u16string& value) {
  auto bytes = utf16ToUtf8(u"");
  bytes.reserve(value.size());
  for (std::size_t index = 0; index < value.size(); ++index) {
    if (value[index] == u'%' && index + 2 < value.size()) {
      const int high = uriHexValue(value[index + 1]);
      const int low = uriHexValue(value[index + 2]);
      if (high >= 0 && low >= 0) {
        bytes.push_back(static_cast<char>((high << 4) | low));
        index += 2;
        continue;
      }
    }
    const auto encoded = utf16ToUtf8(std::u16string_view(&value[index], 1));
    bytes.append(encoded);
  }
  return utf8ToUtf16(bytes);
}

inline std::u16string encodeUriComponentText(const std::u16string& value) {
  static constexpr char16_t HEX[] = u"0123456789ABCDEF";
  std::u16string result;
  for (const unsigned char byte : utf16ToUtf8(value)) {
    if (std::isalnum(byte) || byte == '-' || byte == '_' || byte == '.' || byte == '!' ||
        byte == '~' || byte == '*' || byte == '\'' || byte == '(' || byte == ')') {
      result.push_back(static_cast<char16_t>(byte));
    } else {
      result.push_back(u'%');
      result.push_back(HEX[byte >> 4]);
      result.push_back(HEX[byte & 0x0f]);
    }
  }
  return result;
}

class URLObject final : public cppgc::GarbageCollected<URLObject>, public BaseObject {
 public:
  explicit URLObject(std::u16string value) : href(std::move(value)) {
    const auto separator = href.find(u':');
    if (separator == std::u16string::npos) {
      pathname = href;
    } else {
      protocol = href.substr(0, separator + 1);
      const std::size_t pathStart = href.compare(separator + 1, 2, u"//") == 0
          ? separator + 3
          : separator + 1;
      pathname = pathStart < href.size() ? href.substr(pathStart) : u"";
      if (protocol == u"file:" && (pathname.empty() || pathname.front() != u'/')) pathname.insert(pathname.begin(), u'/');
    }
  }

  const void* dynamicTypeToken() const override { return nativeTypeToken<URLObject>(); }
  void* dynamicCast(const void* type) override { return type == nativeTypeToken<URLObject>() ? this : nullptr; }
  std::u16string dynamicToString() const override { return href; }
  void Trace(cppgc::Visitor* visitor) const override { BaseObject::Trace(visitor); }

  std::u16string href;
  std::u16string protocol;
  std::u16string pathname;
};
