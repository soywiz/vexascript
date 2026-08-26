#include "runtime.hpp"

namespace vexa {




std::u16string jsonQuoted(const std::u16string& value) {
  static constexpr char16_t hex[] = u"0123456789abcdef";
  std::u16string output = u"\"";
  for (const char16_t character : value) {
    switch (character) {
      case u'"': output += u"\\\""; break;
      case u'\\': output += u"\\\\"; break;
      case u'\b': output += u"\\b"; break;
      case u'\f': output += u"\\f"; break;
      case u'\n': output += u"\\n"; break;
      case u'\r': output += u"\\r"; break;
      case u'\t': output += u"\\t"; break;
      default:
        if (character < 0x20) {
          output += u"\\u";
          output += hex[(character >> 12) & 0x0f];
          output += hex[(character >> 8) & 0x0f];
          output += hex[(character >> 4) & 0x0f];
          output += hex[character & 0x0f];
        } else {
          output += character;
        }
    }
  }
  output += u'"';
  return output;
}

Value jsonStringify(const Value& value) {
  if (value.isUndefined() || (value.isRuntimeObject() && value.object()->dynamicToString() == u"function")) {
    return Value::undefined();
  }
  std::unordered_set<const void*> seen;
  return Runtime::string(jsonStringifyNative(value, seen));
}

JsonParser::JsonParser(std::u16string_view source) : source_(source) {}

Value JsonParser::parse() {
    Value result = parseValue();
    skipWhitespace();
    if (position_ != source_.size()) fail(u"unexpected trailing input");
    return result;
  }

[[noreturn]] void JsonParser::fail(const std::u16string& message) const {
    throw runtimeError(
        std::u16string(u"Invalid JSON at offset ") + formatIntegerText(position_) +
        u": " + message);
  }

void JsonParser::skipWhitespace() {
    while (position_ < source_.size() &&
           (source_[position_] == u' ' || source_[position_] == u'\n' ||
            source_[position_] == u'\r' || source_[position_] == u'\t')) ++position_;
  }

bool JsonParser::consume(std::u16string_view text) {
    if (source_.substr(position_, text.size()) != text) return false;
    position_ += text.size();
    return true;
  }

std::uint32_t JsonParser::parseHexCodeUnit() {
    if (position_ + 4 > source_.size()) fail(u"incomplete unicode escape");
    std::uint32_t value = 0;
    for (int index = 0; index < 4; ++index) {
      const char16_t character = source_[position_++];
      const int digit = character >= u'0' && character <= u'9' ? character - u'0'
          : character >= u'a' && character <= u'f' ? character - u'a' + 10
          : character >= u'A' && character <= u'F' ? character - u'A' + 10
          : -1;
      if (digit < 0) fail(u"invalid unicode escape");
      value = (value << 4U) | static_cast<std::uint32_t>(digit);
    }
    return value;
  }

void JsonParser::appendCodePoint(std::u16string& result, std::uint32_t codePoint) {
    if (codePoint <= 0xffff) {
      result.push_back(static_cast<char16_t>(codePoint));
    } else {
      codePoint -= 0x10000;
      result.push_back(static_cast<char16_t>(0xd800 + (codePoint >> 10U)));
      result.push_back(static_cast<char16_t>(0xdc00 + (codePoint & 0x3ff)));
    }
  }

Value JsonParser::parseValue() {
    skipWhitespace();
    if (position_ >= source_.size()) fail(u"expected a value");
    const char16_t next = source_[position_];
    if (next == u'"') return Runtime::string(parseString());
    if (next == u'{') return Value(parseObject());
    if (next == u'[') return Value(parseArray());
    if (consume(u"true")) return Value(true);
    if (consume(u"false")) return Value(false);
    if (consume(u"null")) return Value::null();
    return Value(parseNumber());
  }

std::u16string JsonParser::parseString() {
    if (source_[position_++] != u'"') fail(u"expected a string");
    std::u16string result;
    while (position_ < source_.size()) {
      const char16_t character = source_[position_++];
      if (character == u'"') return result;
      if (character != u'\\') {
        if (character < 0x20) fail(u"unescaped control character");
        result.push_back(character);
        continue;
      }
      if (position_ >= source_.size()) fail(u"unterminated escape");
      const char16_t escaped = source_[position_++];
      switch (escaped) {
        case u'"': result.push_back(u'"'); break;
        case u'\\': result.push_back(u'\\'); break;
        case u'/': result.push_back(u'/'); break;
        case u'b': result.push_back(u'\b'); break;
        case u'f': result.push_back(u'\f'); break;
        case u'n': result.push_back(u'\n'); break;
        case u'r': result.push_back(u'\r'); break;
        case u't': result.push_back(u'\t'); break;
        case u'u': {
          std::uint32_t codePoint = parseHexCodeUnit();
          if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
            if (position_ + 2 > source_.size() || source_[position_] != u'\\' || source_[position_ + 1] != u'u') {
              fail(u"missing low surrogate");
            }
            position_ += 2;
            const std::uint32_t low = parseHexCodeUnit();
            if (low < 0xdc00 || low > 0xdfff) fail(u"invalid low surrogate");
            codePoint = 0x10000 + ((codePoint - 0xd800) << 10U) + (low - 0xdc00);
          } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
            fail(u"unexpected low surrogate");
          }
          appendCodePoint(result, codePoint);
          break;
        }
        default: fail(u"unsupported escape sequence");
      }
    }
    fail(u"unterminated string");
  }

double JsonParser::parseNumber() {
    const std::size_t start = position_;
    if (source_[position_] == u'-') ++position_;
    if (position_ >= source_.size()) fail(u"invalid number");
    if (source_[position_] == u'0') {
      ++position_;
    } else {
      if (source_[position_] < u'0' || source_[position_] > u'9') fail(u"invalid number");
      while (position_ < source_.size() && source_[position_] >= u'0' && source_[position_] <= u'9') ++position_;
    }
    if (position_ < source_.size() && source_[position_] == u'.') {
      ++position_;
      if (position_ >= source_.size() || source_[position_] < u'0' || source_[position_] > u'9') fail(u"invalid fraction");
      while (position_ < source_.size() && source_[position_] >= u'0' && source_[position_] <= u'9') ++position_;
    }
    if (position_ < source_.size() && (source_[position_] == u'e' || source_[position_] == u'E')) {
      ++position_;
      if (position_ < source_.size() && (source_[position_] == u'+' || source_[position_] == u'-')) ++position_;
      if (position_ >= source_.size() || source_[position_] < u'0' || source_[position_] > u'9') fail(u"invalid exponent");
      while (position_ < source_.size() && source_[position_] >= u'0' && source_[position_] <= u'9') ++position_;
    }
    return std::stod(utf16ToUtf8(source_.substr(start, position_ - start)));
  }

ArrayObject<Value>* JsonParser::parseArray() {
    ++position_;
    auto* result = Runtime::array<Value>();
    skipWhitespace();
    if (position_ < source_.size() && source_[position_] == u']') { ++position_; return result; }
    while (true) {
      result->append(parseValue());
      skipWhitespace();
      if (position_ >= source_.size()) fail(u"unterminated array");
      if (source_[position_] == u']') { ++position_; return result; }
      if (source_[position_++] != u',') fail(u"expected ',' in array");
    }
  }

RecordObject* JsonParser::parseObject() {
    ++position_;
    auto* result = Runtime::record();
    skipWhitespace();
    if (position_ < source_.size() && source_[position_] == u'}') { ++position_; return result; }
    while (true) {
      skipWhitespace();
      if (position_ >= source_.size() || source_[position_] != u'"') fail(u"expected an object key");
      const std::u16string key = parseString();
      skipWhitespace();
      if (position_ >= source_.size() || source_[position_++] != u':') fail(u"expected ':' after object key");
      result->set(key, parseValue());
      skipWhitespace();
      if (position_ >= source_.size()) fail(u"unterminated object");
      if (source_[position_] == u'}') { ++position_; return result; }
      if (source_[position_++] != u',') fail(u"expected ',' in object");
    }
  }

Value jsonParse(const Value& source) {
  if (!source.isString()) throw runtimeError(u"JSON.parse expects a string");
  return JsonParser(source.string()).parse();
}
}  // namespace vexa
