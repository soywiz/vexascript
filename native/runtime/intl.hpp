#pragma once

// Internal runtime category header. Include runtime.hpp instead.

class DurationFormatObject final
    : public cppgc::GarbageCollected<DurationFormatObject>, public BaseObject {
 public:
  DurationFormatObject(std::u16string locale, RecordObject* options)
      : locale_(std::move(locale)), style_(u"short") {
    if (options) {
      const Value style = options->get(u"style");
      if (style.isString()) style_ = style.utf16();
    }
  }

  std::u16string format(RecordObject* duration) const {
    static const std::pair<const char16_t*, const char16_t*> units[] = {
      {u"years", u"yr"}, {u"months", u"mo"}, {u"weeks", u"wk"}, {u"days", u"day"},
      {u"hours", u"hr"}, {u"minutes", u"min"}, {u"seconds", u"sec"},
      {u"milliseconds", u"ms"}, {u"microseconds", u"μs"}, {u"nanoseconds", u"ns"},
    };
    std::u16string output;
    for (const auto& [key, shortName] : units) {
      const Value value = duration ? duration->get(key) : Value::undefined();
      if (value.isUndefined() || Number(value) == 0) continue;
      if (!output.empty()) output += u", ";
      output += toString(Number(value));
      output += u" ";
      if (style_ == u"long") {
        std::u16string singular(key);
        if (!singular.empty() && singular.back() == u's') singular.pop_back();
        output += singular;
        if (std::abs(Number(value)) != 1) output += u's';
      } else {
        output += shortName;
      }
    }
    return output;
  }

  ArrayObject<RecordObject*>* formatToParts(RecordObject* duration) const {
    auto* result = makeManaged<ArrayObject<RecordObject*>>();
    const std::u16string text = format(duration);
    if (!text.empty()) {
      auto* part = makeManaged<RecordObject>();
      part->set(u"type", Value(makeManaged<StringObject>(u"literal")));
      part->set(u"value", Value(makeManaged<StringObject>(text)));
      result->append(part);
    }
    return result;
  }

  RecordObject* resolvedOptions() const {
    auto* result = makeManaged<RecordObject>();
    result->set(u"locale", Value(makeManaged<StringObject>(locale_)));
    result->set(u"numberingSystem", Value(makeManaged<StringObject>(u"latn")));
    result->set(u"style", Value(makeManaged<StringObject>(style_)));
    return result;
  }

  const void* dynamicTypeToken() const override { return nativeTypeToken<DurationFormatObject>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<DurationFormatObject>() ? this : nullptr;
  }
  std::u16string dynamicToString() const override { return u"[object Intl.DurationFormat]"; }
  void Trace(cppgc::Visitor* visitor) const override { BaseObject::Trace(visitor); }

 private:
  std::u16string locale_;
  std::u16string style_;
};

enum class IntlObjectKind : std::uint8_t {
  Collator,
  DateTimeFormat,
  DisplayNames,
  ListFormat,
  Locale,
  NumberFormat,
  PluralRules,
  RelativeTimeFormat,
  Segmenter,
};

inline std::u16string canonicalLocale(std::u16string locale) {
  if (locale.empty()) return u"en";
  std::replace(locale.begin(), locale.end(), u'_', u'-');
  std::size_t start = 0;
  int part = 0;
  while (start <= locale.size()) {
    const std::size_t end = locale.find(u'-', start);
    const std::size_t length = (end == std::u16string::npos ? locale.size() : end) - start;
    for (std::size_t index = start; index < start + length; ++index) {
      auto& character = locale[index];
      if (character >= u'A' && character <= u'Z') character += u'a' - u'A';
    }
    if (part > 0 && length == 4 && locale[start] >= u'a' && locale[start] <= u'z') {
      locale[start] -= u'a' - u'A';
    } else if (part > 0 && (length == 2 || length == 3)) {
      for (std::size_t index = start; index < start + length; ++index) {
        if (locale[index] >= u'a' && locale[index] <= u'z') locale[index] -= u'a' - u'A';
      }
    }
    if (end == std::u16string::npos) break;
    start = end + 1;
    ++part;
  }
  return locale;
}

inline bool isSupportedEnglishLocale(const std::u16string& locale) {
  return locale == u"en" || locale.starts_with(u"en-");
}

inline std::tm intlUtcTime(std::time_t seconds) {
  std::tm result{};
#if defined(_WIN32)
  gmtime_s(&result, &seconds);
#else
  gmtime_r(&seconds, &result);
#endif
  return result;
}

inline std::u16string intlPadDecimal(int value, std::size_t width) {
  std::u16string result = utf8ToUtf16(std::to_string(value));
  if (result.size() < width) result.insert(result.begin(), width - result.size(), u'0');
  return result;
}

class IntlSegmentsObject final
    : public cppgc::GarbageCollected<IntlSegmentsObject>, public BaseObject {
 public:
  IntlSegmentsObject(std::u16string input, std::u16string granularity)
      : input_(std::move(input)), items_(makeManaged<ArrayObject<RecordObject*>>()) {
    std::size_t index = 0;
    while (index < input_.size()) {
      std::size_t end = index + 1;
      if (granularity == u"word") {
        const bool whitespace = input_[index] == u' ' || input_[index] == u'\t' || input_[index] == u'\n';
        while (end < input_.size()) {
          const bool nextWhitespace = input_[end] == u' ' || input_[end] == u'\t' || input_[end] == u'\n';
          if (nextWhitespace != whitespace) break;
          ++end;
        }
      } else if (granularity == u"sentence") {
        while (end < input_.size() && input_[end - 1] != u'.' && input_[end - 1] != u'!' && input_[end - 1] != u'?') ++end;
        while (end < input_.size() && input_[end] == u' ') ++end;
      } else if (input_[index] >= 0xD800 && input_[index] <= 0xDBFF && end < input_.size() &&
                 input_[end] >= 0xDC00 && input_[end] <= 0xDFFF) {
        ++end;
      }
      auto* part = makeManaged<RecordObject>();
      part->set(u"segment", Value(makeManaged<StringObject>(input_.substr(index, end - index))));
      part->set(u"index", Value(static_cast<double>(index)));
      part->set(u"input", Value(makeManaged<StringObject>(input_)));
      if (granularity == u"word") part->set(u"isWordLike", Value(input_[index] != u' '));
      items_->append(part);
      index = end;
    }
  }

  Value containing(double codeUnitIndex = 0) const {
    if (!std::isfinite(codeUnitIndex) || codeUnitIndex < 0 || codeUnitIndex >= input_.size()) {
      return Value::undefined();
    }
    const auto requested = static_cast<std::size_t>(std::floor(codeUnitIndex));
    for (std::size_t index = 0; index < items_->size(); ++index) {
      auto* item = items_->get(index);
      const auto start = static_cast<std::size_t>(Number(item->get(u"index")));
      const auto end = index + 1 < items_->size()
        ? static_cast<std::size_t>(Number(items_->get(index + 1)->get(u"index")))
        : input_.size();
      if (requested >= start && requested < end) return Value(item);
    }
    return Value::undefined();
  }

  ArrayObject<RecordObject*>* items() const { return items_.Get(); }
  bool dynamicIsIterable() const override { return true; }
  std::size_t dynamicIterableSize() const override { return items_->size(); }
  Value dynamicIterableGet(std::size_t index) override {
    return index < items_->size() ? Value(items_->get(index)) : Value::undefined();
  }
  const void* dynamicTypeToken() const override { return nativeTypeToken<IntlSegmentsObject>(); }
  void* dynamicCast(const void* type) override {
    if (type == nativeTypeToken<IntlSegmentsObject>()) return this;
    return type == nativeTypeToken<BaseObject>() ? static_cast<BaseObject*>(this) : nullptr;
  }
  std::u16string dynamicToString() const override { return u"[object Intl.Segments]"; }
  void Trace(cppgc::Visitor* visitor) const override {
    BaseObject::Trace(visitor);
    visitor->Trace(items_);
  }

 private:
  std::u16string input_;
  cppgc::Member<ArrayObject<RecordObject*>> items_;
};

inline std::u16string intlLocaleText(const Value& locales) {
  if (locales.isUndefined()) return u"en";
  if (locales.isString()) return canonicalLocale(locales.utf16());
  if (locales.isRuntimeObject() && locales.object()->dynamicIsArray() && locales.object()->dynamicArraySize() > 0) {
    return canonicalLocale(vexa::toString(locales.object()->dynamicArrayGet(0)));
  }
    return canonicalLocale(vexa::toString(locales));
}

class IntlObject final
    : public cppgc::GarbageCollected<IntlObject>, public BaseObject {
 public:
  IntlObject(IntlObjectKind kind, Value locales, Value options = Value::undefined())
      : kind_(kind), locale_(kind == IntlObjectKind::Locale
          ? canonicalLocale(vexa::toString(locales))
          : intlLocaleText(locales)), options_(options.isRecord() ? options.record() : nullptr) {
    if (kind_ == IntlObjectKind::Locale) parseLocale();
  }

  int compare(const std::u16string& left, const std::u16string& right) const {
    const bool numeric = optionBoolean(u"numeric", false);
    if (numeric) {
      try {
        const double leftNumber = std::stod(utf16ToUtf8(left));
        const double rightNumber = std::stod(utf16ToUtf8(right));
        if (leftNumber < rightNumber) return -1;
        if (leftNumber > rightNumber) return 1;
        return 0;
      } catch (...) {}
    }
    const std::u16string sensitivity = optionText(u"sensitivity", u"variant");
    const auto normalizeCase = [&](std::u16string value) {
      if (sensitivity == u"base" || sensitivity == u"accent") {
        for (auto& character : value) {
          if (character >= u'A' && character <= u'Z') character += u'a' - u'A';
        }
      }
      return value;
    };
    const auto normalizedLeft = normalizeCase(left);
    const auto normalizedRight = normalizeCase(right);
    return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0;
  }

  std::u16string format(double value) const {
    if (kind_ == IntlObjectKind::NumberFormat) return formatNumber(value);
    if (kind_ == IntlObjectKind::DateTimeFormat) return formatDate(value);
    return vexa::toString(value);
  }

  std::u16string format(const BigInt& value) const { return value.toString(); }

  std::u16string format(double value, const std::u16string& unit) const {
    const std::u16string style = optionText(u"style", u"long");
    const std::u16string numeric = optionText(u"numeric", u"always");
    if (numeric == u"auto" && value == -1 && unit.starts_with(u"day")) return u"yesterday";
    if (numeric == u"auto" && value == 0 && unit.starts_with(u"day")) return u"today";
    if (numeric == u"auto" && value == 1 && unit.starts_with(u"day")) return u"tomorrow";
    std::u16string name = unit;
    if (style == u"short" && name.size() > 3) name = name.substr(0, 3) + u".";
    if (style == u"narrow" && !name.empty()) name = name.substr(0, 1);
    if (style == u"long" && std::abs(value) != 1 && !name.ends_with(u"s")) name += u"s";
    return value < 0
      ? vexa::toString(std::abs(value)) + u" " + name + u" ago"
      : u"in " + vexa::toString(value) + u" " + name;
  }

  template <typename T>
  std::u16string format(ArrayObject<T>* values) const {
    if (!values || values->empty()) return u"";
    const std::u16string type = optionText(u"type", u"conjunction");
    const std::u16string style = optionText(u"style", u"long");
    const std::u16string conjunction = type == u"disjunction" ? u"or" : u"and";
    std::u16string result;
    for (std::size_t index = 0; index < values->size(); ++index) {
      const std::u16string item = vexa::toString(convertValue<Value>(values->get(index)));
      if (index > 0) {
        if (index + 1 == values->size()) result += values->size() > 2 && style == u"long" ? u", " : u" ";
        else result += u", ";
        if (index + 1 == values->size()) result += conjunction + u" ";
      }
      result += item;
    }
    return result;
  }

  std::u16string formatRange(double start, double end) const {
    return format(start) + u" – " + format(end);
  }

  ArrayObject<RecordObject*>* formatToParts(double value) const {
    return singlePart(kind_ == IntlObjectKind::NumberFormat ? u"integer" : u"literal", format(value));
  }

  ArrayObject<RecordObject*>* formatToParts(double value, const std::u16string& unit) const {
    auto* result = makeManaged<ArrayObject<RecordObject*>>();
    auto* number = makeManaged<RecordObject>();
    number->set(u"type", Value(makeManaged<StringObject>(u"integer")));
    number->set(u"value", Value(makeManaged<StringObject>(vexa::toString(std::abs(value)))));
    number->set(u"unit", Value(makeManaged<StringObject>(unit)));
    result->append(number);
    auto* literal = makeManaged<RecordObject>();
    literal->set(u"type", Value(makeManaged<StringObject>(u"literal")));
    literal->set(u"value", Value(makeManaged<StringObject>(value < 0 ? u" ago" : u"in ")));
    result->append(literal);
    return result;
  }

  template <typename T>
  ArrayObject<RecordObject*>* formatToParts(ArrayObject<T>* values) const {
    auto* result = makeManaged<ArrayObject<RecordObject*>>();
    if (!values) return result;
    for (std::size_t index = 0; index < values->size(); ++index) {
      auto* part = makeManaged<RecordObject>();
      part->set(u"type", Value(makeManaged<StringObject>(index == 0 ? u"element" : u"literal")));
      part->set(u"value", Value(makeManaged<StringObject>(vexa::toString(convertValue<Value>(values->get(index))))));
      result->append(part);
    }
    return result;
  }

  ArrayObject<RecordObject*>* formatRangeToParts(double start, double end) const {
    auto* result = singlePart(u"integer", format(start));
    result->get(0)->set(u"source", Value(makeManaged<StringObject>(u"startRange")));
    auto* separator = makeManaged<RecordObject>();
    separator->set(u"type", Value(makeManaged<StringObject>(u"literal")));
    separator->set(u"value", Value(makeManaged<StringObject>(u" – ")));
    separator->set(u"source", Value(makeManaged<StringObject>(u"shared")));
    result->append(separator);
    auto* endPart = makeManaged<RecordObject>();
    endPart->set(u"type", Value(makeManaged<StringObject>(u"integer")));
    endPart->set(u"value", Value(makeManaged<StringObject>(format(end))));
    endPart->set(u"source", Value(makeManaged<StringObject>(u"endRange")));
    result->append(endPart);
    return result;
  }

  std::u16string select(double value) const {
    const std::u16string type = optionText(u"type", u"cardinal");
    if (type == u"ordinal") {
      const int integer = static_cast<int>(std::abs(value));
      if (integer % 10 == 1 && integer % 100 != 11) return u"one";
      if (integer % 10 == 2 && integer % 100 != 12) return u"two";
      if (integer % 10 == 3 && integer % 100 != 13) return u"few";
      return u"other";
    }
    return std::abs(value) == 1 ? u"one" : u"other";
  }

  std::u16string selectRange(double start, double end) const {
    return start == end ? select(start) : u"other";
  }

  Value of(const std::u16string& code) const {
    static const std::unordered_map<std::u16string, std::u16string> englishNames = {
      {u"US", u"United States"}, {u"GB", u"United Kingdom"}, {u"ES", u"Spain"},
      {u"EUR", u"Euro"}, {u"USD", u"US Dollar"}, {u"en", u"English"}, {u"es", u"Spanish"},
    };
    const auto found = englishNames.find(code);
    if (found != englishNames.end()) return Value(makeManaged<StringObject>(found->second));
    return optionText(u"fallback", u"code") == u"none"
      ? Value::undefined()
      : Value(makeManaged<StringObject>(code));
  }

  RecordObject* resolvedOptions() const {
    auto* result = makeManaged<RecordObject>();
    result->set(u"locale", Value(makeManaged<StringObject>(locale_)));
    result->set(u"numberingSystem", Value(makeManaged<StringObject>(u"latn")));
    switch (kind_) {
      case IntlObjectKind::Collator:
        result->set(u"usage", Value(makeManaged<StringObject>(optionText(u"usage", u"sort"))));
        result->set(u"sensitivity", Value(makeManaged<StringObject>(optionText(u"sensitivity", u"variant"))));
        result->set(u"ignorePunctuation", Value(optionBoolean(u"ignorePunctuation", false)));
        result->set(u"collation", Value(makeManaged<StringObject>(optionText(u"collation", u"default"))));
        result->set(u"caseFirst", Value(makeManaged<StringObject>(optionText(u"caseFirst", u"false"))));
        result->set(u"numeric", Value(optionBoolean(u"numeric", false)));
        break;
      case IntlObjectKind::NumberFormat:
        result->set(u"style", Value(makeManaged<StringObject>(optionText(u"style", u"decimal"))));
        result->set(u"useGrouping", Value(optionBoolean(u"useGrouping", true)));
        result->set(u"minimumIntegerDigits", Value(1));
        break;
      case IntlObjectKind::DateTimeFormat:
        result->set(u"calendar", Value(makeManaged<StringObject>(optionText(u"calendar", u"gregory"))));
        result->set(u"timeZone", Value(makeManaged<StringObject>(optionText(u"timeZone", u"UTC"))));
        break;
      case IntlObjectKind::PluralRules:
        result->set(u"type", Value(makeManaged<StringObject>(optionText(u"type", u"cardinal"))));
        {
          auto* categories = makeManaged<ArrayObject<std::u16string>>();
          categories->append(u"one");
          categories->append(u"other");
          result->set(u"pluralCategories", Value(categories));
        }
        break;
      case IntlObjectKind::RelativeTimeFormat:
        result->set(u"style", Value(makeManaged<StringObject>(optionText(u"style", u"long"))));
        result->set(u"numeric", Value(makeManaged<StringObject>(optionText(u"numeric", u"always"))));
        break;
      case IntlObjectKind::ListFormat:
        result->set(u"style", Value(makeManaged<StringObject>(optionText(u"style", u"long"))));
        result->set(u"type", Value(makeManaged<StringObject>(optionText(u"type", u"conjunction"))));
        break;
      case IntlObjectKind::DisplayNames:
        result->set(u"style", Value(makeManaged<StringObject>(optionText(u"style", u"long"))));
        result->set(u"type", Value(makeManaged<StringObject>(optionText(u"type", u"language"))));
        result->set(u"fallback", Value(makeManaged<StringObject>(optionText(u"fallback", u"code"))));
        break;
      case IntlObjectKind::Segmenter:
        result->set(u"granularity", Value(makeManaged<StringObject>(optionText(u"granularity", u"grapheme"))));
        break;
      case IntlObjectKind::Locale:
        break;
    }
    return result;
  }

  IntlSegmentsObject* segment(const std::u16string& input) const {
    return makeManaged<IntlSegmentsObject>(input, optionText(u"granularity", u"grapheme"));
  }

  IntlObject* maximize() const {
    std::u16string result = locale_;
    if (result == u"en" || result == u"en-US") {
      result = u"en-Latn-US";
    } else if (result.starts_with(u"en-") && result.find(u"Latn") == std::u16string::npos) {
      result = u"en-Latn-" + result.substr(3);
    }
    return makeManaged<IntlObject>(
      IntlObjectKind::Locale,
      Value(makeManaged<StringObject>(result)),
      options_ ? Value(options_.Get()) : Value::undefined()
    );
  }

  IntlObject* minimize() const {
    std::u16string result = locale_;
    if (result == u"en-US" || result == u"en-Latn-US") result = u"en";
    else if (result.starts_with(u"en-Latn-")) result = u"en-" + result.substr(8);
    return makeManaged<IntlObject>(
      IntlObjectKind::Locale,
      Value(makeManaged<StringObject>(result)),
      options_ ? Value(options_.Get()) : Value::undefined()
    );
  }

  const std::u16string& toString() const { return locale_; }
  const std::u16string& baseName() const { return base_name_; }
  const std::u16string& language() const { return language_; }
  Value script() const { return script_.empty() ? Value::undefined() : Value(makeManaged<StringObject>(script_)); }
  Value region() const { return region_.empty() ? Value::undefined() : Value(makeManaged<StringObject>(region_)); }
  Value calendar() const { return optionValue(u"calendar"); }
  Value caseFirst() const { return optionValue(u"caseFirst"); }
  Value collation() const { return optionValue(u"collation"); }
  Value hourCycle() const { return optionValue(u"hourCycle"); }
  Value numberingSystem() const { return optionValue(u"numberingSystem"); }
  bool numeric() const { return optionBoolean(u"numeric", false); }

  const void* dynamicTypeToken() const override { return nativeTypeToken<IntlObject>(); }
  void* dynamicCast(const void* type) override {
    if (type == nativeTypeToken<IntlObject>()) return this;
    return type == nativeTypeToken<BaseObject>() ? static_cast<BaseObject*>(this) : nullptr;
  }
  std::u16string dynamicToString() const override {
    return kind_ == IntlObjectKind::Locale ? locale_ : u"[object Intl]";
  }
  void Trace(cppgc::Visitor* visitor) const override {
    BaseObject::Trace(visitor);
    visitor->Trace(options_);
  }

 private:
  Value optionValue(const std::u16string& key) const {
    return options_ ? options_->get(key) : Value::undefined();
  }
  std::u16string optionText(const std::u16string& key, std::u16string fallback) const {
    const Value value = optionValue(key);
    return value.isString() ? value.utf16() : fallback;
  }
  bool optionBoolean(const std::u16string& key, bool fallback) const {
    const Value value = optionValue(key);
    return value.isUndefined() ? fallback : static_cast<bool>(value);
  }
  std::u16string formatNumber(double value) const {
    const std::u16string style = optionText(u"style", u"decimal");
    if (style == u"percent") return vexa::toString(value * 100) + u"%";
    if (style == u"currency") {
      const std::u16string currency = optionText(u"currency", u"USD");
      return currency + u" " + formatNumberText(value, 2);
    }
    return vexa::toString(value);
  }
  std::u16string formatDate(double milliseconds) const {
    const auto seconds = static_cast<std::time_t>(std::floor(milliseconds / 1000));
    const std::tm value = intlUtcTime(seconds);
    return intlPadDecimal(value.tm_year + 1900, 4) + u"-" + intlPadDecimal(value.tm_mon + 1, 2) + u"-" + intlPadDecimal(value.tm_mday, 2);
  }
  ArrayObject<RecordObject*>* singlePart(const std::u16string& type, const std::u16string& value) const {
    auto* result = makeManaged<ArrayObject<RecordObject*>>();
    auto* part = makeManaged<RecordObject>();
    part->set(u"type", Value(makeManaged<StringObject>(type)));
    part->set(u"value", Value(makeManaged<StringObject>(value)));
    result->append(part);
    return result;
  }
  void parseLocale() {
    base_name_ = locale_;
    language_.clear();
    script_.clear();
    region_.clear();
    std::size_t start = 0;
    int part = 0;
    while (start <= locale_.size()) {
      const std::size_t end = locale_.find(u'-', start);
      const std::u16string token = locale_.substr(start, end == std::u16string::npos ? locale_.size() - start : end - start);
      if (part == 0) language_ = token;
      else if (token.size() == 4) script_ = token;
      else if (token.size() == 2 || token.size() == 3) region_ = token;
      if (end == std::u16string::npos) break;
      start = end + 1;
      ++part;
    }
  }

  IntlObjectKind kind_;
  std::u16string locale_;
  cppgc::Member<RecordObject> options_;
  std::u16string base_name_;
  std::u16string language_;
  std::u16string script_;
  std::u16string region_;
};

inline ArrayObject<std::u16string>* intlCanonicalLocales(const Value& locales) {
  auto* result = makeManaged<ArrayObject<std::u16string>>();
  std::unordered_set<std::u16string> seen;
  const auto append = [&](const Value& value) {
    const std::u16string locale = canonicalLocale(toString(value));
    if (seen.insert(locale).second) result->append(locale);
  };
  if (locales.isRuntimeObject() && locales.object()->dynamicIsArray()) {
    for (std::size_t index = 0; index < locales.object()->dynamicArraySize(); ++index) {
      append(locales.object()->dynamicArrayGet(index));
    }
  } else {
    append(locales);
  }
  return result;
}

inline ArrayObject<std::u16string>* intlSupportedLocales(const Value& locales) {
  auto* canonical = intlCanonicalLocales(locales);
  auto* supported = makeManaged<ArrayObject<std::u16string>>();
  for (std::size_t index = 0; index < canonical->size(); ++index) {
    if (isSupportedEnglishLocale(canonical->get(index))) supported->append(canonical->get(index));
  }
  return supported;
}

inline ArrayObject<std::u16string>* intlSupportedValuesOf(const std::u16string& key) {
  auto* result = makeManaged<ArrayObject<std::u16string>>();
  if (key == u"calendar") result->append(u"gregory");
  else if (key == u"collation") result->append(u"default");
  else if (key == u"currency") {
    result->append(u"EUR");
    result->append(u"GBP");
    result->append(u"USD");
  } else if (key == u"numberingSystem") result->append(u"latn");
  else if (key == u"timeZone") result->append(u"UTC");
  else if (key == u"unit") {
    result->append(u"day");
    result->append(u"hour");
    result->append(u"minute");
    result->append(u"second");
  } else {
    throw runtimeError(u"Unsupported Intl.supportedValuesOf key");
  }
  return result;
}
