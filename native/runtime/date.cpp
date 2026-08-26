#include "runtime.hpp"

namespace vexa {

double DateObject::parse(const std::u16string& text) {
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

double DateObject::utc(
      double year,
      double month,
      double date,
      double hours,
      double minutes,
      double seconds,
      double milliseconds) {
    return fromParts(year, month, date, hours, minutes, seconds, milliseconds, true);
  }

double DateObject::getTime() const { return milliseconds_; }

double DateObject::valueOf() const { return milliseconds_; }

double DateObject::getFullYear() const { return localParts().tm_year + 1900; }

double DateObject::getMonth() const { return localParts().tm_mon; }

double DateObject::getDate() const { return localParts().tm_mday; }

double DateObject::getDay() const { return localParts().tm_wday; }

double DateObject::getHours() const { return localParts().tm_hour; }

double DateObject::getMinutes() const { return localParts().tm_min; }

double DateObject::getSeconds() const { return localParts().tm_sec; }

double DateObject::getMilliseconds() const { return millisecondPart(); }

double DateObject::getTimezoneOffset() const {
    const auto seconds = static_cast<std::time_t>(std::floor(milliseconds_ / 1000.0));
    std::tm utc = utcParts();
    return std::difftime(std::mktime(&utc), seconds) / 60.0;
  }

double DateObject::getUTCFullYear() const { return utcParts().tm_year + 1900; }

double DateObject::getUTCMonth() const { return utcParts().tm_mon; }

double DateObject::getUTCDate() const { return utcParts().tm_mday; }

double DateObject::getUTCDay() const { return utcParts().tm_wday; }

double DateObject::getUTCHours() const { return utcParts().tm_hour; }

double DateObject::getUTCMinutes() const { return utcParts().tm_min; }

double DateObject::getUTCSeconds() const { return utcParts().tm_sec; }

double DateObject::getUTCMilliseconds() const {
    return millisecondPart();
  }

double DateObject::setTime(double milliseconds) { return milliseconds_ = milliseconds; }

double DateObject::setMilliseconds(double value) { return setLocalParts(std::nullopt, std::nullopt, std::nullopt, std::nullopt, std::nullopt, std::nullopt, value); }

double DateObject::setSeconds(double seconds, double milliseconds) { return setLocalParts(std::nullopt, std::nullopt, std::nullopt, std::nullopt, std::nullopt, seconds, optionalPart(milliseconds)); }

double DateObject::setMinutes(double minutes, double seconds, double milliseconds) { return setLocalParts(std::nullopt, std::nullopt, std::nullopt, std::nullopt, minutes, optionalPart(seconds), optionalPart(milliseconds)); }

double DateObject::setHours(double hours, double minutes, double seconds, double milliseconds) { return setLocalParts(std::nullopt, std::nullopt, std::nullopt, hours, optionalPart(minutes), optionalPart(seconds), optionalPart(milliseconds)); }

double DateObject::setDate(double date) { return setLocalParts(std::nullopt, std::nullopt, date); }

double DateObject::setMonth(double month, double date) { return setLocalParts(std::nullopt, month, optionalPart(date)); }

double DateObject::setFullYear(double year, double month, double date) { return setLocalParts(year, optionalPart(month), optionalPart(date)); }

double DateObject::setUTCMilliseconds(double value) { return setUtcParts(std::nullopt, std::nullopt, std::nullopt, std::nullopt, std::nullopt, std::nullopt, value); }

double DateObject::setUTCSeconds(double seconds, double milliseconds) { return setUtcParts(std::nullopt, std::nullopt, std::nullopt, std::nullopt, std::nullopt, seconds, optionalPart(milliseconds)); }

double DateObject::setUTCMinutes(double minutes, double seconds, double milliseconds) { return setUtcParts(std::nullopt, std::nullopt, std::nullopt, std::nullopt, minutes, optionalPart(seconds), optionalPart(milliseconds)); }

double DateObject::setUTCHours(double hours, double minutes, double seconds, double milliseconds) { return setUtcParts(std::nullopt, std::nullopt, std::nullopt, hours, optionalPart(minutes), optionalPart(seconds), optionalPart(milliseconds)); }

double DateObject::setUTCDate(double date) { return setUtcParts(std::nullopt, std::nullopt, date); }

double DateObject::setUTCMonth(double month, double date) { return setUtcParts(std::nullopt, month, optionalPart(date)); }

double DateObject::setUTCFullYear(double year, double month, double date) { return setUtcParts(year, optionalPart(month), optionalPart(date)); }

std::u16string DateObject::toISOString() const {
    if (!std::isfinite(milliseconds_)) throw runtimeError(u"Invalid time value");
    const std::tm parts = utcParts();
    return formatIsoDateText(parts, static_cast<int>(getUTCMilliseconds()));
  }

std::u16string DateObject::toString() const { return toISOString(); }

std::u16string DateObject::toJSON() const { return toISOString(); }

std::u16string DateObject::toUTCString() const { return formatDate(utcParts(), u" GMT", true, true); }

std::u16string DateObject::toDateString() const { return formatDate(localParts(), u"", true, false); }

std::u16string DateObject::toTimeString() const { return formatDate(localParts(), u"", false, true); }

std::u16string DateObject::toLocaleString() const { return formatDate(localParts(), u"", true, true); }

std::u16string DateObject::toLocaleDateString() const { return toDateString(); }

std::u16string DateObject::toLocaleTimeString() const { return toTimeString(); }

const void* DateObject::dynamicTypeToken() const { return nativeTypeToken<DateObject>(); }

void* DateObject::dynamicCast(const void* type) {
    return type == nativeTypeToken<DateObject>() ? this : nullptr;
  }

std::u16string DateObject::dynamicToString() const { return toString(); }

std::optional<std::u16string> DateObject::dynamicJsonStringify(std::unordered_set<const void*>&) const {
    return jsonQuoted(toISOString());
  }

void DateObject::Trace(cppgc::Visitor* visitor) const { BaseObject::Trace(visitor); }

std::optional<double> DateObject::optionalPart(double value) {
    return std::isnan(value) ? std::nullopt : std::optional<double>(value);
  }

std::time_t DateObject::partsToTime(std::tm* parts, bool utc) {
#if defined(_WIN32)
    return utc ? _mkgmtime(parts) : std::mktime(parts);
#else
    return utc ? timegm(parts) : std::mktime(parts);
#endif
  }

double DateObject::fromParts(
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

double DateObject::millisecondPart() const {
    const double remainder = std::fmod(milliseconds_, 1000.0);
    return remainder < 0 ? remainder + 1000.0 : remainder;
  }

double DateObject::setParts(
      bool utc,
      std::optional<double> year,
      std::optional<double> month,
      std::optional<double> date,
      std::optional<double> hours,
      std::optional<double> minutes,
      std::optional<double> seconds,
      std::optional<double> milliseconds) {
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

double DateObject::setLocalParts(
      std::optional<double> year,
      std::optional<double> month,
      std::optional<double> date,
      std::optional<double> hours,
      std::optional<double> minutes,
      std::optional<double> seconds,
      std::optional<double> milliseconds) {
    return setParts(false, year, month, date, hours, minutes, seconds, milliseconds);
  }

double DateObject::setUtcParts(
      std::optional<double> year,
      std::optional<double> month,
      std::optional<double> date,
      std::optional<double> hours,
      std::optional<double> minutes,
      std::optional<double> seconds,
      std::optional<double> milliseconds) {
    return setParts(true, year, month, date, hours, minutes, seconds, milliseconds);
  }

std::u16string DateObject::formatDate(const std::tm& parts, const std::u16string& suffix, bool date, bool time) {
    char buffer[64];
    const char* format = date && time ? "%a %b %d %Y %H:%M:%S" : date ? "%a %b %d %Y" : "%H:%M:%S";
    std::strftime(buffer, sizeof(buffer), format, &parts);
    return utf8ToUtf16(buffer) + suffix;
  }

std::tm DateObject::localParts() const {
    const auto seconds = static_cast<std::time_t>(std::floor(milliseconds_ / 1000.0));
    std::tm result{};
#if defined(_WIN32)
    localtime_s(&result, &seconds);
#else
    localtime_r(&seconds, &result);
#endif
    return result;
  }

std::tm DateObject::utcParts() const {
    const auto seconds = static_cast<std::time_t>(std::floor(milliseconds_ / 1000.0));
    std::tm result{};
#if defined(_WIN32)
    gmtime_s(&result, &seconds);
#else
    gmtime_r(&seconds, &result);
#endif
    return result;
  }

double dateNow() {
  return std::chrono::duration<double, std::milli>(
      std::chrono::system_clock::now().time_since_epoch()).count();
}

double dateParse(const std::u16string& value) { return DateObject::parse(value); }

double dateUTC(
    double year,
    double month,
    double date,
    double hours,
    double minutes,
    double seconds,
    double milliseconds) {
  return DateObject::utc(year, month, date, hours, minutes, seconds, milliseconds);
}


DateObject::DateObject()
      : milliseconds_(std::chrono::duration<double, std::milli>(
            std::chrono::system_clock::now().time_since_epoch()).count()) {}

DateObject::DateObject(double milliseconds) : milliseconds_(milliseconds) {}

DateObject::DateObject(const std::u16string& text) : milliseconds_(parse(text)) {}

DateObject::DateObject(
      double year,
      double month,
      double date,
      double hours,
      double minutes,
      double seconds,
      double milliseconds)
      : milliseconds_(fromParts(year, month, date, hours, minutes, seconds, milliseconds, false)) {}
}  // namespace vexa
