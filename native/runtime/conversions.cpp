#include "runtime.hpp"

namespace vexa {

std::u16string numberToString(double value) {
  if (std::isnan(value)) return u"NaN";
  if (std::isinf(value)) return value < 0 ? u"-Infinity" : u"Infinity";
  if (value == 0) return u"0";
  return formatNumberText(value);
}

std::u16string numberToString(double value, double radix) {
  if (!std::isfinite(radix) || std::trunc(radix) != radix || radix < 2 || radix > 36) {
    throw runtimeError(u"Number.toString radix must be an integer between 2 and 36");
  }
  if (!std::isfinite(value) || value == 0 || std::trunc(value) != value) {
    return numberToString(value);
  }

  const auto base = static_cast<std::uint32_t>(radix);
  const bool negative = value < 0;
  const long double magnitude = std::abs(static_cast<long double>(value));
  if (magnitude > static_cast<long double>(std::numeric_limits<std::uint64_t>::max())) {
    return numberToString(value);
  }
  auto remaining = static_cast<std::uint64_t>(magnitude);
  static constexpr char16_t digits[] = u"0123456789abcdefghijklmnopqrstuvwxyz";
  std::u16string result;
  do {
    result.insert(result.begin(), digits[remaining % base]);
    remaining /= base;
  } while (remaining != 0);
  if (negative) result.insert(result.begin(), u'-');
  return result;
}

std::u16string toString(const Value& value) {
  if (value.isUndefined()) return u"undefined";
  if (value.isNull()) return u"null";
  if (value.isBoolean()) return value.boolean() ? u"true" : u"false";
  if (value.isNumber()) return numberToString(value.number());
  if (value.isBigInt()) return value.bigint().toString();
  if (value.isString()) return value.string();
  if (value.isRuntimeObject()) return value.object()->dynamicToString();
  return u"[object Object]";
}

std::u16string toString(const Value& value, double radix) {
  return value.isNumber() ? numberToString(value.number(), radix) : toString(value);
}

std::u16string toString(const BigInt& value) { return value.toString(); }

std::u16string toString(double value) { return numberToString(value); }

std::u16string toString(double value, double radix) { return numberToString(value, radix); }

std::u16string toString(int value) { return formatIntegerText(value); }

std::u16string toString(int value, double radix) { return numberToString(static_cast<double>(value), radix); }

std::u16string toString(std::int64_t value) { return formatIntegerText(value); }

std::u16string toString(std::int64_t value, double radix) { return numberToString(static_cast<double>(value), radix); }

std::u16string toString(bool value) { return value ? u"true" : u"false"; }

const std::u16string& toString(const std::u16string& value) { return value; }

BigInt makeBigInt(const BigInt& value) { return value; }

BigInt makeBigInt(bool value) { return BigInt(value ? 1 : 0); }

BigInt makeBigInt(std::int32_t value) { return BigInt(value); }

BigInt makeBigInt(std::int64_t value) { return BigInt(static_cast<long long>(value)); }

BigInt makeBigInt(double value) {
  if (!std::isfinite(value) || std::trunc(value) != value) {
    throw runtimeError(u"Cannot convert a non-integer number to BigInt");
  }
  return BigInt(formatFixedText(value, 0));
}

BigInt makeBigInt(const std::u16string& value) { return BigInt(value); }

BigInt makeBigInt(const Value& value) {
  if (value.isBigInt()) return value.bigint();
  if (value.isBoolean()) return makeBigInt(value.boolean());
  if (value.isNumber()) return makeBigInt(value.number());
  if (value.isString()) return makeBigInt(value.string());
  throw runtimeError(u"Cannot convert value to BigInt");
}

void throwValue(const Error& error) {
  throw RejectedValue(Runtime::string(error.messageText()));
}

void throwValue(const Value& value) { throw RejectedValue(value); }

}  // namespace vexa
