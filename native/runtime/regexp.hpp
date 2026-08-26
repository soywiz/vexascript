#pragma once

// Internal runtime category header. Include runtime.hpp instead.

class RegExp final {
 public:
  RegExp();
  RegExp(std::u16string pattern, const std::u16string& rawFlags);

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

  bool test(const std::u16string& value) const;
  std::optional<std::vector<std::u16string>> exec(const std::u16string& value) const;
  double search(const std::u16string& value) const;
  std::vector<std::vector<std::u16string>> execAll(const std::u16string& value) const;
  RegExp& compile(std::u16string pattern, const std::u16string& rawFlags = u"");
  std::u16string toString() const;

  static const std::u16string& legacyCapture(std::size_t index);
  static const std::u16string& legacyInput();
  static const std::u16string& legacyLastMatch();
  static const std::u16string& legacyLastParen();
  static const std::u16string& legacyLeftContext();
  static const std::u16string& legacyRightContext();
  std::u16string replace(const std::u16string& value, const std::u16string& replacement) const;

  std::vector<std::u16string> split(const std::u16string& value) const;

 private:
  static std::shared_ptr<const Utf16Regex> cachedExpression(
      std::u16string pattern,
      bool caseInsensitive);

  std::shared_ptr<const Utf16Regex> expression_;
  static std::array<std::u16string, 9> legacyCaptures_;
  static std::u16string legacyInput_;
  static std::u16string legacyLastMatch_;
  static std::u16string legacyLastParen_;
  static std::u16string legacyLeftContext_;
  static std::u16string legacyRightContext_;
};

const std::u16string& regexLegacyCapture(double index);
const std::u16string& regexLegacyInput();
const std::u16string& regexLegacyLastMatch();
const std::u16string& regexLegacyLastParen();
const std::u16string& regexLegacyLeftContext();
const std::u16string& regexLegacyRightContext();

std::u16string regexEscape(const std::u16string& value);

std::u16string regexEscape(const Value& value);

bool regexTest(const RegExp& expression, const std::u16string& value);
