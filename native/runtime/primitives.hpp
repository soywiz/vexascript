#pragma once

// Internal runtime category header. Include runtime.hpp instead.

double valueOf(double value);
bool valueOf(bool value);
const BigInt& valueOf(const BigInt& value);
const std::u16string& valueOf(const std::u16string& value);
const Value& valueOf(const Value& value);

template <typename... Values>
inline std::u16string concat(std::u16string value, const Values&... values) {
  (value.append(toString(values)), ...);
  return value;
}

std::u16string toLocaleString(const BigInt& value);
