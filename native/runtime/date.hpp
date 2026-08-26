#pragma once

// Internal runtime category header. Include runtime.hpp instead.

class DateObject final : public cppgc::GarbageCollected<DateObject>, public BaseObject {
 public:
  DateObject()
      : milliseconds_(std::chrono::duration<double, std::milli>(
            std::chrono::system_clock::now().time_since_epoch()).count()) {}
  explicit DateObject(double milliseconds) : milliseconds_(milliseconds) {}
  explicit DateObject(const std::u16string& text) : milliseconds_(parse(text)) {}
  DateObject(
      double year,
      double month,
      double date = 1,
      double hours = 0,
      double minutes = 0,
      double seconds = 0,
      double milliseconds = 0)
      : milliseconds_(fromParts(year, month, date, hours, minutes, seconds, milliseconds, false)) {}

  static double parse(const std::u16string& text) {
    std::tm parts{};
    char separator = 0;
    char zone = 0;
    int milliseconds = 0;
    const auto encoded = utf16ToUtf8(text);
    const int fields = std::sscanf(
        encoded.c_str(), "%d-%d-%d%c%d:%d:%d.%d%c",
        &parts.tm_year, &parts.tm_mon, &parts.tm_mday, &separator,
        &parts.tm_hour, &parts.tm_min, &parts.tm_sec, &milliseconds, &zone);
    if (fields != 3 && !(fields >= 8 && separator == 'T' && (fields == 8 || zone == 'Z'))) {
      return std::numeric_limits<double>::quiet_NaN();
    }
    parts.tm_year -= 1900;
    parts.tm_mon -= 1;
#if defined(_WIN32)
    const std::time_t seconds = _mkgmtime(&parts);
#else
    const std::time_t seconds = timegm(&parts);
#endif
    return seconds == static_cast<std::time_t>(-1)
        ? std::numeric_limits<double>::quiet_NaN()
        : static_cast<double>(seconds) * 1000.0 + milliseconds;
  }

  static double utc(
      double year,
      double month = 0,
      double date = 1,
      double hours = 0,
      double minutes = 0,
      double seconds = 0,
      double milliseconds = 0) {
    return fromParts(year, month, date, hours, minutes, seconds, milliseconds, true);
  }

  double getTime() const { return milliseconds_; }
  double valueOf() const { return milliseconds_; }
  double getFullYear() const { return localParts().tm_year + 1900; }
  double getMonth() const { return localParts().tm_mon; }
  double getDate() const { return localParts().tm_mday; }
  double getDay() const { return localParts().tm_wday; }
  double getHours() const { return localParts().tm_hour; }
  double getMinutes() const { return localParts().tm_min; }
  double getSeconds() const { return localParts().tm_sec; }
  double getMilliseconds() const { return millisecondPart(); }
  double getTimezoneOffset() const {
    const auto seconds = static_cast<std::time_t>(std::floor(milliseconds_ / 1000.0));
    std::tm utc = utcParts();
    return std::difftime(std::mktime(&utc), seconds) / 60.0;
  }
  double getUTCFullYear() const { return utcParts().tm_year + 1900; }
  double getUTCMonth() const { return utcParts().tm_mon; }
  double getUTCDate() const { return utcParts().tm_mday; }
  double getUTCDay() const { return utcParts().tm_wday; }
  double getUTCHours() const { return utcParts().tm_hour; }
  double getUTCMinutes() const { return utcParts().tm_min; }
  double getUTCSeconds() const { return utcParts().tm_sec; }
  double getUTCMilliseconds() const {
    return millisecondPart();
  }

  double setTime(double milliseconds) { return milliseconds_ = milliseconds; }
  double setMilliseconds(double value) { return setLocalParts(std::nullopt, std::nullopt, std::nullopt, std::nullopt, std::nullopt, std::nullopt, value); }
  double setSeconds(double seconds, double milliseconds = std::numeric_limits<double>::quiet_NaN()) { return setLocalParts(std::nullopt, std::nullopt, std::nullopt, std::nullopt, std::nullopt, seconds, optionalPart(milliseconds)); }
  double setMinutes(double minutes, double seconds = std::numeric_limits<double>::quiet_NaN(), double milliseconds = std::numeric_limits<double>::quiet_NaN()) { return setLocalParts(std::nullopt, std::nullopt, std::nullopt, std::nullopt, minutes, optionalPart(seconds), optionalPart(milliseconds)); }
  double setHours(double hours, double minutes = std::numeric_limits<double>::quiet_NaN(), double seconds = std::numeric_limits<double>::quiet_NaN(), double milliseconds = std::numeric_limits<double>::quiet_NaN()) { return setLocalParts(std::nullopt, std::nullopt, std::nullopt, hours, optionalPart(minutes), optionalPart(seconds), optionalPart(milliseconds)); }
  double setDate(double date) { return setLocalParts(std::nullopt, std::nullopt, date); }
  double setMonth(double month, double date = std::numeric_limits<double>::quiet_NaN()) { return setLocalParts(std::nullopt, month, optionalPart(date)); }
  double setFullYear(double year, double month = std::numeric_limits<double>::quiet_NaN(), double date = std::numeric_limits<double>::quiet_NaN()) { return setLocalParts(year, optionalPart(month), optionalPart(date)); }
  double setUTCMilliseconds(double value) { return setUtcParts(std::nullopt, std::nullopt, std::nullopt, std::nullopt, std::nullopt, std::nullopt, value); }
  double setUTCSeconds(double seconds, double milliseconds = std::numeric_limits<double>::quiet_NaN()) { return setUtcParts(std::nullopt, std::nullopt, std::nullopt, std::nullopt, std::nullopt, seconds, optionalPart(milliseconds)); }
  double setUTCMinutes(double minutes, double seconds = std::numeric_limits<double>::quiet_NaN(), double milliseconds = std::numeric_limits<double>::quiet_NaN()) { return setUtcParts(std::nullopt, std::nullopt, std::nullopt, std::nullopt, minutes, optionalPart(seconds), optionalPart(milliseconds)); }
  double setUTCHours(double hours, double minutes = std::numeric_limits<double>::quiet_NaN(), double seconds = std::numeric_limits<double>::quiet_NaN(), double milliseconds = std::numeric_limits<double>::quiet_NaN()) { return setUtcParts(std::nullopt, std::nullopt, std::nullopt, hours, optionalPart(minutes), optionalPart(seconds), optionalPart(milliseconds)); }
  double setUTCDate(double date) { return setUtcParts(std::nullopt, std::nullopt, date); }
  double setUTCMonth(double month, double date = std::numeric_limits<double>::quiet_NaN()) { return setUtcParts(std::nullopt, month, optionalPart(date)); }
  double setUTCFullYear(double year, double month = std::numeric_limits<double>::quiet_NaN(), double date = std::numeric_limits<double>::quiet_NaN()) { return setUtcParts(year, optionalPart(month), optionalPart(date)); }

  std::u16string toISOString() const {
    if (!std::isfinite(milliseconds_)) throw runtimeError(u"Invalid time value");
    const std::tm parts = utcParts();
    return formatIsoDateText(parts, static_cast<int>(getUTCMilliseconds()));
  }

  std::u16string toString() const { return toISOString(); }
  std::u16string toJSON() const { return toISOString(); }
  std::u16string toUTCString() const { return formatDate(utcParts(), u" GMT", true, true); }
  std::u16string toDateString() const { return formatDate(localParts(), u"", true, false); }
  std::u16string toTimeString() const { return formatDate(localParts(), u"", false, true); }
  std::u16string toLocaleString() const { return formatDate(localParts(), u"", true, true); }
  std::u16string toLocaleDateString() const { return toDateString(); }
  std::u16string toLocaleTimeString() const { return toTimeString(); }

  const void* dynamicTypeToken() const override { return nativeTypeToken<DateObject>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<DateObject>() ? this : nullptr;
  }
  std::u16string dynamicToString() const override { return toString(); }
  std::optional<std::u16string> dynamicJsonStringify(std::unordered_set<const void*>&) const override {
    return jsonQuoted(toISOString());
  }
  void Trace(cppgc::Visitor* visitor) const override { BaseObject::Trace(visitor); }

 private:
  static std::optional<double> optionalPart(double value) {
    return std::isnan(value) ? std::nullopt : std::optional<double>(value);
  }

  static std::time_t partsToTime(std::tm* parts, bool utc) {
#if defined(_WIN32)
    return utc ? _mkgmtime(parts) : std::mktime(parts);
#else
    return utc ? timegm(parts) : std::mktime(parts);
#endif
  }

  static double fromParts(
      double year, double month, double date, double hours, double minutes,
      double seconds, double milliseconds, bool utc) {
    std::tm parts{};
    const auto normalizedYear = static_cast<int>(std::trunc(year));
    parts.tm_year = (normalizedYear >= 0 && normalizedYear <= 99 ? normalizedYear + 1900 : normalizedYear) - 1900;
    parts.tm_mon = static_cast<int>(std::trunc(month));
    parts.tm_mday = static_cast<int>(std::trunc(date));
    parts.tm_hour = static_cast<int>(std::trunc(hours));
    parts.tm_min = static_cast<int>(std::trunc(minutes));
    parts.tm_sec = static_cast<int>(std::trunc(seconds));
    parts.tm_isdst = utc ? 0 : -1;
    const auto timestamp = partsToTime(&parts, utc);
    return timestamp == static_cast<std::time_t>(-1)
      ? std::numeric_limits<double>::quiet_NaN()
      : static_cast<double>(timestamp) * 1000.0 + std::trunc(milliseconds);
  }

  double millisecondPart() const {
    const double remainder = std::fmod(milliseconds_, 1000.0);
    return remainder < 0 ? remainder + 1000.0 : remainder;
  }

  double setParts(
      bool utc,
      std::optional<double> year = std::nullopt,
      std::optional<double> month = std::nullopt,
      std::optional<double> date = std::nullopt,
      std::optional<double> hours = std::nullopt,
      std::optional<double> minutes = std::nullopt,
      std::optional<double> seconds = std::nullopt,
      std::optional<double> milliseconds = std::nullopt) {
    std::tm parts = utc ? utcParts() : localParts();
    if (year) parts.tm_year = static_cast<int>(std::trunc(*year)) - 1900;
    if (month) parts.tm_mon = static_cast<int>(std::trunc(*month));
    if (date) parts.tm_mday = static_cast<int>(std::trunc(*date));
    if (hours) parts.tm_hour = static_cast<int>(std::trunc(*hours));
    if (minutes) parts.tm_min = static_cast<int>(std::trunc(*minutes));
    if (seconds) parts.tm_sec = static_cast<int>(std::trunc(*seconds));
    parts.tm_isdst = utc ? 0 : -1;
    const auto timestamp = partsToTime(&parts, utc);
    milliseconds_ = timestamp == static_cast<std::time_t>(-1)
      ? std::numeric_limits<double>::quiet_NaN()
      : static_cast<double>(timestamp) * 1000.0 + (milliseconds ? std::trunc(*milliseconds) : millisecondPart());
    return milliseconds_;
  }

  double setLocalParts(
      std::optional<double> year = std::nullopt,
      std::optional<double> month = std::nullopt,
      std::optional<double> date = std::nullopt,
      std::optional<double> hours = std::nullopt,
      std::optional<double> minutes = std::nullopt,
      std::optional<double> seconds = std::nullopt,
      std::optional<double> milliseconds = std::nullopt) {
    return setParts(false, year, month, date, hours, minutes, seconds, milliseconds);
  }

  double setUtcParts(
      std::optional<double> year = std::nullopt,
      std::optional<double> month = std::nullopt,
      std::optional<double> date = std::nullopt,
      std::optional<double> hours = std::nullopt,
      std::optional<double> minutes = std::nullopt,
      std::optional<double> seconds = std::nullopt,
      std::optional<double> milliseconds = std::nullopt) {
    return setParts(true, year, month, date, hours, minutes, seconds, milliseconds);
  }

  static std::u16string formatDate(const std::tm& parts, const std::u16string& suffix, bool date, bool time) {
    char buffer[64];
    const char* format = date && time ? "%a %b %d %Y %H:%M:%S" : date ? "%a %b %d %Y" : "%H:%M:%S";
    std::strftime(buffer, sizeof(buffer), format, &parts);
    return utf8ToUtf16(buffer) + suffix;
  }

  std::tm localParts() const {
    const auto seconds = static_cast<std::time_t>(std::floor(milliseconds_ / 1000.0));
    std::tm result{};
#if defined(_WIN32)
    localtime_s(&result, &seconds);
#else
    localtime_r(&seconds, &result);
#endif
    return result;
  }

  std::tm utcParts() const {
    const auto seconds = static_cast<std::time_t>(std::floor(milliseconds_ / 1000.0));
    std::tm result{};
#if defined(_WIN32)
    gmtime_s(&result, &seconds);
#else
    gmtime_r(&seconds, &result);
#endif
    return result;
  }

  double milliseconds_;
};

inline double dateNow() {
  return std::chrono::duration<double, std::milli>(
      std::chrono::system_clock::now().time_since_epoch()).count();
}

inline double dateParse(const std::u16string& value) { return DateObject::parse(value); }

inline double dateUTC(
    double year,
    double month = 0,
    double date = 1,
    double hours = 0,
    double minutes = 0,
    double seconds = 0,
    double milliseconds = 0) {
  return DateObject::utc(year, month, date, hours, minutes, seconds, milliseconds);
}
