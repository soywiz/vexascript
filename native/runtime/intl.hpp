#pragma once

// Internal runtime category header. Include runtime.hpp instead.

class DurationFormatObject final
    : public cppgc::GarbageCollected<DurationFormatObject>, public BaseObject {
 public:
  DurationFormatObject(std::u16string locale, RecordObject* options);

  std::u16string format(RecordObject* duration) const;

  ArrayObject<RecordObject*>* formatToParts(RecordObject* duration) const;

  RecordObject* resolvedOptions() const;

  const void* dynamicTypeToken() const override;
  void* dynamicCast(const void* type) override;
  std::u16string dynamicToString() const override;
  void Trace(cppgc::Visitor* visitor) const override;

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

std::u16string canonicalLocale(std::u16string locale);

bool isSupportedEnglishLocale(const std::u16string& locale);

std::tm intlUtcTime(std::time_t seconds);

std::u16string intlPadDecimal(int value, std::size_t width);

class IntlSegmentsObject final
    : public cppgc::GarbageCollected<IntlSegmentsObject>, public BaseObject {
 public:
  IntlSegmentsObject(std::u16string input, std::u16string granularity);

  Value containing(double codeUnitIndex = 0) const;

  ArrayObject<RecordObject*>* items() const;
  bool dynamicIsIterable() const override;
  std::size_t dynamicIterableSize() const override;
  Value dynamicIterableGet(std::size_t index) override;
  const void* dynamicTypeToken() const override;
  void* dynamicCast(const void* type) override;
  std::u16string dynamicToString() const override;
  void Trace(cppgc::Visitor* visitor) const override;

 private:
  std::u16string input_;
  cppgc::Member<ArrayObject<RecordObject*>> items_;
};

std::u16string intlLocaleText(const Value& locales);

class IntlObject final
    : public cppgc::GarbageCollected<IntlObject>, public BaseObject {
 public:
  IntlObject(IntlObjectKind kind, Value locales, Value options = Value::undefined());

  int compare(const std::u16string& left, const std::u16string& right) const;

  std::u16string format(double value) const;

  std::u16string format(const BigInt& value) const;

  std::u16string format(double value, const std::u16string& unit) const;

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

  std::u16string formatRange(double start, double end) const;

  ArrayObject<RecordObject*>* formatToParts(double value) const;

  ArrayObject<RecordObject*>* formatToParts(double value, const std::u16string& unit) const;

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

  ArrayObject<RecordObject*>* formatRangeToParts(double start, double end) const;

  std::u16string select(double value) const;

  std::u16string selectRange(double start, double end) const;

  Value of(const std::u16string& code) const;

  RecordObject* resolvedOptions() const;

  IntlSegmentsObject* segment(const std::u16string& input) const;

  IntlObject* maximize() const;

  IntlObject* minimize() const;

  const std::u16string& toString() const;
  const std::u16string& baseName() const;
  const std::u16string& language() const;
  Value script() const;
  Value region() const;
  Value calendar() const;
  Value caseFirst() const;
  Value collation() const;
  Value hourCycle() const;
  Value numberingSystem() const;
  bool numeric() const;

  const void* dynamicTypeToken() const override;
  void* dynamicCast(const void* type) override;
  std::u16string dynamicToString() const override;
  void Trace(cppgc::Visitor* visitor) const override;

 private:
  Value optionValue(const std::u16string& key) const;
  std::u16string optionText(const std::u16string& key, std::u16string fallback) const;
  bool optionBoolean(const std::u16string& key, bool fallback) const;
  std::u16string formatNumber(double value) const;
  std::u16string formatDate(double milliseconds) const;
  ArrayObject<RecordObject*>* singlePart(const std::u16string& type, const std::u16string& value) const;
  void parseLocale();

  IntlObjectKind kind_;
  std::u16string locale_;
  cppgc::Member<RecordObject> options_;
  std::u16string base_name_;
  std::u16string language_;
  std::u16string script_;
  std::u16string region_;
};

ArrayObject<std::u16string>* intlCanonicalLocales(const Value& locales);

ArrayObject<std::u16string>* intlSupportedLocales(const Value& locales);

ArrayObject<std::u16string>* intlSupportedValuesOf(const std::u16string& key);
