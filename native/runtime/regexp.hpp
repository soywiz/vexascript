#pragma once

// Internal runtime category header. Include runtime.hpp instead.

class RegExp final {
 public:
  RegExp() : RegExp(u"", u"") {}
  RegExp(std::u16string pattern, const std::u16string& rawFlags)
      : global(rawFlags.find(u'g') != std::u16string::npos),
        ignoreCase(rawFlags.find(u'i') != std::u16string::npos),
        multiline(rawFlags.find(u'm') != std::u16string::npos),
        dotAll(rawFlags.find(u's') != std::u16string::npos),
        sticky(rawFlags.find(u'y') != std::u16string::npos),
        unicode(rawFlags.find(u'u') != std::u16string::npos),
        unicodeSets(rawFlags.find(u'v') != std::u16string::npos),
        hasIndices(rawFlags.find(u'd') != std::u16string::npos),
        source(pattern.empty() ? u"(?:)" : pattern),
        flags(rawFlags),
        expression_(cachedExpression(std::move(pattern), ignoreCase)) {}

  bool global;
  bool ignoreCase;
  bool multiline;
  bool dotAll;
  bool sticky;
  bool unicode;
  bool unicodeSets;
  bool hasIndices;
  std::u16string source;
  std::u16string flags;
  mutable double lastIndex = 0;

  bool test(const std::u16string& value) const { return exec(value).has_value(); }
  std::optional<std::vector<std::u16string>> exec(const std::u16string& value) const {
    const std::size_t start = global || sticky
      ? static_cast<std::size_t>(std::clamp(lastIndex, 0.0, static_cast<double>(value.size())))
      : 0;
    const std::u16string suffix = value.substr(start);
    const double relative = expression_->search(suffix);
    if (relative < 0 || (sticky && relative != 0)) {
      if (global || sticky) lastIndex = 0;
      return std::nullopt;
    }
    const auto matchStart = start + static_cast<std::size_t>(relative);
    auto captures = expression_->exec(value.substr(matchStart));
    if (!captures) {
      if (global || sticky) lastIndex = 0;
      return std::nullopt;
    }
    const std::size_t matchLength = captures->empty() ? 0 : captures->front().size();
    if (global || sticky) lastIndex = static_cast<double>(matchStart + std::max<std::size_t>(matchLength, 1));
    legacyInput_ = value;
    legacyLastMatch_ = captures->empty() ? u"" : captures->front();
    legacyLastParen_ = captures->size() > 1 ? captures->back() : u"";
    legacyLeftContext_ = value.substr(0, matchStart);
    legacyRightContext_ = value.substr(matchStart + matchLength);
    legacyCaptures_.fill(u"");
    for (std::size_t index = 1; index < captures->size() && index <= legacyCaptures_.size(); ++index) {
      legacyCaptures_[index - 1] = (*captures)[index];
    }
    return captures;
  }
  double search(const std::u16string& value) const { return expression_->search(value); }
  std::vector<std::vector<std::u16string>> execAll(const std::u16string& value) const {
    return expression_->execAll(value);
  }
  RegExp& compile(std::u16string pattern, const std::u16string& rawFlags = u"") {
    *this = RegExp(std::move(pattern), rawFlags);
    return *this;
  }
  std::u16string toString() const { return u"/" + source + u"/" + flags; }

  static const std::u16string& legacyCapture(std::size_t index) {
    static const std::u16string empty;
    return index < legacyCaptures_.size() ? legacyCaptures_[index] : empty;
  }
  static const std::u16string& legacyInput() { return legacyInput_; }
  static const std::u16string& legacyLastMatch() { return legacyLastMatch_; }
  static const std::u16string& legacyLastParen() { return legacyLastParen_; }
  static const std::u16string& legacyLeftContext() { return legacyLeftContext_; }
  static const std::u16string& legacyRightContext() { return legacyRightContext_; }
  std::u16string replace(const std::u16string& value, const std::u16string& replacement) const {
    return expression_->replace(value, replacement);
  }

  std::vector<std::u16string> split(const std::u16string& value) const {
    return expression_->split(value);
  }

 private:
  static std::shared_ptr<const Utf16Regex> cachedExpression(
      std::u16string pattern,
      bool caseInsensitive) {
    static std::unordered_map<std::u16string, std::shared_ptr<const Utf16Regex>> cache;
    std::u16string key;
    key.reserve(pattern.size() + 1);
    key.push_back(caseInsensitive ? u'i' : u'-');
    key += pattern;
    const auto found = cache.find(key);
    if (found != cache.end()) return found->second;
    auto expression = std::make_shared<const Utf16Regex>(std::move(pattern), caseInsensitive);
    cache.emplace(std::move(key), expression);
    return expression;
  }

  std::shared_ptr<const Utf16Regex> expression_;
  inline static std::array<std::u16string, 9> legacyCaptures_{};
  inline static std::u16string legacyInput_;
  inline static std::u16string legacyLastMatch_;
  inline static std::u16string legacyLastParen_;
  inline static std::u16string legacyLeftContext_;
  inline static std::u16string legacyRightContext_;
};

inline const std::u16string& regexLegacyCapture(double index) {
  return RegExp::legacyCapture(static_cast<std::size_t>(std::max(0.0, std::trunc(index))));
}
inline const std::u16string& regexLegacyInput() { return RegExp::legacyInput(); }
inline const std::u16string& regexLegacyLastMatch() { return RegExp::legacyLastMatch(); }
inline const std::u16string& regexLegacyLastParen() { return RegExp::legacyLastParen(); }
inline const std::u16string& regexLegacyLeftContext() { return RegExp::legacyLeftContext(); }
inline const std::u16string& regexLegacyRightContext() { return RegExp::legacyRightContext(); }

inline std::u16string regexEscape(const std::u16string& value) {
  static constexpr char16_t hex[] = u"0123456789abcdef";
  const auto appendHex = [&](std::u16string& output, char16_t character, bool byte) {
    output += byte ? u"\\x" : u"\\u";
    const int digits = byte ? 2 : 4;
    for (int shift = (digits - 1) * 4; shift >= 0; shift -= 4) {
      output += hex[(character >> shift) & 0xF];
    }
  };
  std::u16string output;
  for (std::size_t index = 0; index < value.size(); ++index) {
    const char16_t character = value[index];
    const bool asciiLetterOrDigit =
        (character >= u'a' && character <= u'z') ||
        (character >= u'A' && character <= u'Z') ||
        (character >= u'0' && character <= u'9');
    if (index == 0 && asciiLetterOrDigit) {
      appendHex(output, character, true);
    } else if (std::u16string(u"^$\\.*+?()[]{}|/").find(character) != std::u16string::npos) {
      output += u'\\';
      output += character;
    } else if (std::u16string(u",-=<>#&!%:;@~'`").find(character) != std::u16string::npos) {
      appendHex(output, character, true);
    } else {
      switch (character) {
        case u'\f': output += u"\\f"; break;
        case u'\n': output += u"\\n"; break;
        case u'\r': output += u"\\r"; break;
        case u'\t': output += u"\\t"; break;
        case u'\v': output += u"\\v"; break;
        case u' ': output += u"\\x20"; break;
        default:
          if (character == 0x2028 || character == 0x2029 ||
              (character >= 0xD800 && character <= 0xDFFF)) {
            appendHex(output, character, false);
          } else {
            output += character;
          }
      }
    }
  }
  return output;
}

inline std::u16string regexEscape(const Value& value) {
  return regexEscape(requireString(value));
}

inline bool regexTest(const RegExp& expression, const std::u16string& value) {
  return expression.test(value);
}
