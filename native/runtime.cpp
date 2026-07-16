// Minimal VexaScript C++ runtime. This file is intentionally both a header and
// an implementation so generated translation units can include one runtime file.
#pragma once

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <limits>
#include <memory>
#include <sstream>
#include <string>
#include <string_view>
#include <utility>
#include <variant>

#include <cppgc/allocation.h>
#include <cppgc/garbage-collected.h>
#include <cppgc/heap.h>
#include <cppgc/persistent.h>
#include <cppgc/platform.h>
#include <cppgc/visitor.h>
#include <src/base/page-allocator.h>

namespace vexa {

class OilpanPlatform final : public cppgc::Platform {
 public:
  cppgc::PageAllocator* GetPageAllocator() override { return &allocator_; }

  double MonotonicallyIncreasingTime() override {
    using Seconds = std::chrono::duration<double>;
    return Seconds(std::chrono::steady_clock::now().time_since_epoch()).count();
  }

 private:
  v8::base::PageAllocator allocator_;
};

class StringObject final : public cppgc::GarbageCollected<StringObject> {
 public:
  explicit StringObject(std::string value) : value_(std::move(value)) {}

  void Trace(cppgc::Visitor*) const {}
  const std::string& value() const { return value_; }

 private:
  std::string value_;
};

struct Undefined final {};
struct Null final {};

class Value final {
 public:
  using Storage = std::variant<Undefined, Null, bool, double, cppgc::Persistent<StringObject>>;

  Value() : storage_(Undefined{}) {}
  Value(bool value) : storage_(value) {}
  Value(double value) : storage_(value) {}
  Value(int value) : storage_(static_cast<double>(value)) {}
  explicit Value(StringObject* value) : storage_(cppgc::Persistent<StringObject>(value)) {}

  static Value undefined() { return Value(); }
  static Value null() { return Value(Null{}); }

  bool isUndefined() const { return std::holds_alternative<Undefined>(storage_); }
  bool isNull() const { return std::holds_alternative<Null>(storage_); }
  bool isBoolean() const { return std::holds_alternative<bool>(storage_); }
  bool isNumber() const { return std::holds_alternative<double>(storage_); }
  bool isString() const { return std::holds_alternative<cppgc::Persistent<StringObject>>(storage_); }

  bool boolean() const { return std::get<bool>(storage_); }
  double number() const { return std::get<double>(storage_); }
  const std::string& string() const {
    return std::get<cppgc::Persistent<StringObject>>(storage_)->value();
  }

 private:
  explicit Value(Null value) : storage_(value) {}
  Storage storage_;
};

class Runtime final {
 public:
  Runtime() : platform_(std::make_shared<OilpanPlatform>()) {
    cppgc::InitializeProcess(platform_->GetPageAllocator());
    cppgc::Heap::HeapOptions options;
    options.marking_support = cppgc::Heap::MarkingType::kAtomic;
    options.sweeping_support = cppgc::Heap::SweepingType::kAtomic;
    options.stack_support = cppgc::Heap::StackSupport::kSupportsConservativeStackScan;
    options.stack_start_marker.emplace();
    heap_ = cppgc::Heap::Create(platform_, std::move(options));
  }

  Runtime(const Runtime&) = delete;
  Runtime& operator=(const Runtime&) = delete;

  ~Runtime() {
    heap_.reset();
    cppgc::ShutdownProcess();
  }

  Value string(std::string value) {
    return Value(cppgc::MakeGarbageCollected<StringObject>(
        heap_->GetAllocationHandle(), std::move(value)));
  }

  template <typename T, typename... Arguments>
  T* make(Arguments&&... arguments) {
    return cppgc::MakeGarbageCollected<T>(
        heap_->GetAllocationHandle(), std::forward<Arguments>(arguments)...);
  }

  cppgc::Heap& heap() { return *heap_; }

 private:
  std::shared_ptr<OilpanPlatform> platform_;
  std::unique_ptr<cppgc::Heap> heap_;
};

inline std::string numberToString(double value) {
  if (std::isnan(value)) return "NaN";
  if (std::isinf(value)) return value < 0 ? "-Infinity" : "Infinity";
  if (value == 0) return "0";
  std::ostringstream output;
  output << std::setprecision(15) << value;
  return output.str();
}

inline std::string toString(const Value& value) {
  if (value.isUndefined()) return "undefined";
  if (value.isNull()) return "null";
  if (value.isBoolean()) return value.boolean() ? "true" : "false";
  if (value.isNumber()) return numberToString(value.number());
  return value.string();
}

inline std::string toString(double value) { return numberToString(value); }
inline std::string toString(int value) { return std::to_string(value); }
inline std::string toString(bool value) { return value ? "true" : "false"; }
inline const std::string& toString(const std::string& value) { return value; }
inline double valueOf(double value) { return value; }
inline bool valueOf(bool value) { return value; }
inline const Value& valueOf(const Value& value) { return value; }

inline std::string toFixed(double value, int digits = 0) {
  std::ostringstream output;
  output << std::fixed << std::setprecision(std::clamp(digits, 0, 100)) << value;
  return output.str();
}

inline std::string toUpperCase(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
    return static_cast<char>(std::toupper(character));
  });
  return value;
}
inline std::string toUpperCase(const Value& value) { return toUpperCase(toString(value)); }

inline std::string toLowerCase(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
    return static_cast<char>(std::tolower(character));
  });
  return value;
}
inline std::string toLowerCase(const Value& value) { return toLowerCase(toString(value)); }

inline std::string trim(std::string value) {
  const auto isSpace = [](unsigned char character) { return std::isspace(character) != 0; };
  value.erase(value.begin(), std::find_if_not(value.begin(), value.end(), isSpace));
  value.erase(std::find_if_not(value.rbegin(), value.rend(), isSpace).base(), value.end());
  return value;
}
inline std::string trim(const Value& value) { return trim(toString(value)); }

inline double Number(double value) { return value; }
inline double Number(bool value) { return value ? 1 : 0; }
inline double Number(const Value& value) {
  if (value.isNumber()) return value.number();
  if (value.isBoolean()) return value.boolean() ? 1 : 0;
  if (value.isNull()) return 0;
  if (value.isUndefined()) return std::numeric_limits<double>::quiet_NaN();
  try {
    return std::stod(value.string());
  } catch (...) {
    return std::numeric_limits<double>::quiet_NaN();
  }
}

template <typename T>
inline std::string String(const T& value) {
  return toString(value);
}

inline bool Boolean(bool value) { return value; }
inline bool Boolean(double value) { return value != 0 && !std::isnan(value); }
inline bool Boolean(const Value& value) {
  if (value.isUndefined() || value.isNull()) return false;
  if (value.isBoolean()) return value.boolean();
  if (value.isNumber()) return Boolean(value.number());
  return !value.string().empty();
}

inline double parseFloat(const std::string& value) {
  try {
    return std::stod(value);
  } catch (...) {
    return std::numeric_limits<double>::quiet_NaN();
  }
}

inline double parseFloat(const Value& value) { return parseFloat(toString(value)); }
inline double parseInt(const std::string& value, int radix = 10) {
  try {
    return static_cast<double>(std::stoll(value, nullptr, radix));
  } catch (...) {
    return std::numeric_limits<double>::quiet_NaN();
  }
}
inline double parseInt(const Value& value, int radix = 10) { return parseInt(toString(value), radix); }
inline bool isNaN(double value) { return std::isnan(value); }
inline bool isFinite(double value) { return std::isfinite(value); }

inline std::string typeOf(const Value& value) {
  if (value.isUndefined()) return "undefined";
  if (value.isBoolean()) return "boolean";
  if (value.isNumber()) return "number";
  if (value.isString()) return "string";
  return "object";
}
inline std::string typeOf(double) { return "number"; }
inline std::string typeOf(bool) { return "boolean"; }
inline std::string typeOf(const std::string&) { return "string"; }

struct Math final {
  static constexpr double E = 2.71828182845904523536;
  static constexpr double LN2 = 0.69314718055994530942;
  static constexpr double LN10 = 2.30258509299404568402;
  static constexpr double PI = 3.14159265358979323846;
  static constexpr double SQRT2 = 1.41421356237309504880;

  static double abs(double value) { return std::abs(value); }
  static double acos(double value) { return std::acos(value); }
  static double asin(double value) { return std::asin(value); }
  static double atan(double value) { return std::atan(value); }
  static double atan2(double y, double x) { return std::atan2(y, x); }
  static double ceil(double value) { return std::ceil(value); }
  static double cos(double value) { return std::cos(value); }
  static double exp(double value) { return std::exp(value); }
  static double floor(double value) { return std::floor(value); }
  static double log(double value) { return std::log(value); }
  static double log2(double value) { return std::log2(value); }
  static double log10(double value) { return std::log10(value); }
  static double round(double value) { return std::round(value); }
  static double sign(double value) { return (0 < value) - (value < 0); }
  static double sin(double value) { return std::sin(value); }
  static double sqrt(double value) { return std::sqrt(value); }
  static double tan(double value) { return std::tan(value); }
  static double trunc(double value) { return std::trunc(value); }
  static double pow(double base, double exponent) { return std::pow(base, exponent); }
  static double min(double left, double right) { return std::min(left, right); }
  static double max(double left, double right) { return std::max(left, right); }
  static double hypot(double left, double right) { return std::hypot(left, right); }
  static double random() {
    return static_cast<double>(std::rand()) / static_cast<double>(RAND_MAX);
  }
};

class Console final {
 public:
  template <typename... Arguments>
  void log(const Arguments&... arguments) const {
    write(std::cout, arguments...);
  }

  template <typename... Arguments>
  void info(const Arguments&... arguments) const {
    write(std::cout, arguments...);
  }

  template <typename... Arguments>
  void warn(const Arguments&... arguments) const {
    write(std::cerr, arguments...);
  }

  template <typename... Arguments>
  void error(const Arguments&... arguments) const {
    write(std::cerr, arguments...);
  }

 private:
  static void print(std::ostream& output, const Value& value) { output << toString(value); }
  static void print(std::ostream& output, const std::string& value) { output << value; }
  static void print(std::ostream& output, const char* value) { output << value; }
  static void print(std::ostream& output, bool value) { output << (value ? "true" : "false"); }
  static void print(std::ostream& output, double value) { output << numberToString(value); }
  static void print(std::ostream& output, float value) { output << numberToString(value); }

  template <typename T>
  static void print(std::ostream& output, const T& value) {
    output << value;
  }

  template <typename... Arguments>
  static void write(std::ostream& output, const Arguments&... arguments) {
    bool first = true;
    const auto printArgument = [&](const auto& argument) {
      if (!first) output << ' ';
      first = false;
      print(output, argument);
    };
    (printArgument(arguments), ...);
    output << '\n';
  }
};

inline const Console console;

}  // namespace vexa
