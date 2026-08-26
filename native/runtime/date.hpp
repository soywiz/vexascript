#pragma once

// Internal runtime category header. Include runtime.hpp instead.

class DateObject final : public cppgc::GarbageCollected<DateObject>, public BaseObject {
 public:
  DateObject();
  explicit DateObject(double milliseconds);
  explicit DateObject(const std::u16string& text);
  DateObject(
      double year,
      double month,
      double date = 1,
      double hours = 0,
      double minutes = 0,
      double seconds = 0,
      double milliseconds = 0);

  static double parse(const std::u16string& text);

  static double utc(
      double year,
      double month = 0,
      double date = 1,
      double hours = 0,
      double minutes = 0,
      double seconds = 0,
      double milliseconds = 0);

  double getTime() const;
  double valueOf() const;
  double getFullYear() const;
  double getMonth() const;
  double getDate() const;
  double getDay() const;
  double getHours() const;
  double getMinutes() const;
  double getSeconds() const;
  double getMilliseconds() const;
  double getTimezoneOffset() const;
  double getUTCFullYear() const;
  double getUTCMonth() const;
  double getUTCDate() const;
  double getUTCDay() const;
  double getUTCHours() const;
  double getUTCMinutes() const;
  double getUTCSeconds() const;
  double getUTCMilliseconds() const;

  double setTime(double milliseconds);
  double setMilliseconds(double value);
  double setSeconds(double seconds, double milliseconds = std::numeric_limits<double>::quiet_NaN());
  double setMinutes(double minutes, double seconds = std::numeric_limits<double>::quiet_NaN(), double milliseconds = std::numeric_limits<double>::quiet_NaN());
  double setHours(double hours, double minutes = std::numeric_limits<double>::quiet_NaN(), double seconds = std::numeric_limits<double>::quiet_NaN(), double milliseconds = std::numeric_limits<double>::quiet_NaN());
  double setDate(double date);
  double setMonth(double month, double date = std::numeric_limits<double>::quiet_NaN());
  double setFullYear(double year, double month = std::numeric_limits<double>::quiet_NaN(), double date = std::numeric_limits<double>::quiet_NaN());
  double setUTCMilliseconds(double value);
  double setUTCSeconds(double seconds, double milliseconds = std::numeric_limits<double>::quiet_NaN());
  double setUTCMinutes(double minutes, double seconds = std::numeric_limits<double>::quiet_NaN(), double milliseconds = std::numeric_limits<double>::quiet_NaN());
  double setUTCHours(double hours, double minutes = std::numeric_limits<double>::quiet_NaN(), double seconds = std::numeric_limits<double>::quiet_NaN(), double milliseconds = std::numeric_limits<double>::quiet_NaN());
  double setUTCDate(double date);
  double setUTCMonth(double month, double date = std::numeric_limits<double>::quiet_NaN());
  double setUTCFullYear(double year, double month = std::numeric_limits<double>::quiet_NaN(), double date = std::numeric_limits<double>::quiet_NaN());

  std::u16string toISOString() const;

  std::u16string toString() const;
  std::u16string toJSON() const;
  std::u16string toUTCString() const;
  std::u16string toDateString() const;
  std::u16string toTimeString() const;
  std::u16string toLocaleString() const;
  std::u16string toLocaleDateString() const;
  std::u16string toLocaleTimeString() const;

  const void* dynamicTypeToken() const override;
  void* dynamicCast(const void* type) override;
  std::u16string dynamicToString() const override;
  std::optional<std::u16string> dynamicJsonStringify(std::unordered_set<const void*>&) const override;
  void Trace(cppgc::Visitor* visitor) const override;

 private:
  static std::optional<double> optionalPart(double value);

  static std::time_t partsToTime(std::tm* parts, bool utc);

  static double fromParts(
      double year, double month, double date, double hours, double minutes,
      double seconds, double milliseconds, bool utc);

  double millisecondPart() const;

  double setParts(
      bool utc,
      std::optional<double> year = std::nullopt,
      std::optional<double> month = std::nullopt,
      std::optional<double> date = std::nullopt,
      std::optional<double> hours = std::nullopt,
      std::optional<double> minutes = std::nullopt,
      std::optional<double> seconds = std::nullopt,
      std::optional<double> milliseconds = std::nullopt);

  double setLocalParts(
      std::optional<double> year = std::nullopt,
      std::optional<double> month = std::nullopt,
      std::optional<double> date = std::nullopt,
      std::optional<double> hours = std::nullopt,
      std::optional<double> minutes = std::nullopt,
      std::optional<double> seconds = std::nullopt,
      std::optional<double> milliseconds = std::nullopt);

  double setUtcParts(
      std::optional<double> year = std::nullopt,
      std::optional<double> month = std::nullopt,
      std::optional<double> date = std::nullopt,
      std::optional<double> hours = std::nullopt,
      std::optional<double> minutes = std::nullopt,
      std::optional<double> seconds = std::nullopt,
      std::optional<double> milliseconds = std::nullopt);

  static std::u16string formatDate(const std::tm& parts, const std::u16string& suffix, bool date, bool time);

  std::tm localParts() const;

  std::tm utcParts() const;

  double milliseconds_;
};

double dateNow();

double dateParse(const std::u16string& value);

double dateUTC(
    double year,
    double month = 0,
    double date = 1,
    double hours = 0,
    double minutes = 0,
    double seconds = 0,
    double milliseconds = 0);
