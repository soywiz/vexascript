#pragma once

// Internal runtime category header. Include runtime.hpp instead.

std::u16string numberToString(double value);

std::u16string numberToString(double value, double radix);

std::u16string toString(const Value& value);

std::u16string toString(const Value& value, double radix);

std::u16string toString(const BigInt& value);

std::u16string toString(double value);
std::u16string toString(double value, double radix);
std::u16string toString(int value);
std::u16string toString(int value, double radix);
std::u16string toString(std::int64_t value);
std::u16string toString(std::int64_t value, double radix);
std::u16string toString(bool value);
const std::u16string& toString(const std::u16string& value);

template <typename T>
  requires std::is_base_of_v<BaseObject, T>
inline std::u16string toString(T* value) {
  return value ? value->dynamicToString() : u"null";
}

BigInt makeBigInt(const BigInt& value);
BigInt makeBigInt(bool value);
BigInt makeBigInt(std::int32_t value);
BigInt makeBigInt(std::int64_t value);
BigInt makeBigInt(double value);
BigInt makeBigInt(const std::u16string& value);
BigInt makeBigInt(const Value& value);

template <typename T>
inline std::u16string toString(ArrayObject<T>* array);

[[noreturn]] void throwValue(const Error& error);

[[noreturn]] void throwValue(const Value& value);

template <typename T>
  requires std::is_base_of_v<BaseObject, T>
[[noreturn]] inline void throwValue(T* value) {
  throw RejectedValue(Value(value));
}

template <typename T>
[[noreturn]] inline void throwValue(const T& value) {
  throw runtimeError(toString(value));
}
