#pragma once

// Internal runtime category header. Include runtime.hpp instead.

inline double valueOf(double value) { return value; }
inline bool valueOf(bool value) { return value; }
inline const BigInt& valueOf(const BigInt& value) { return value; }
inline const std::u16string& valueOf(const std::u16string& value) { return value; }
inline const Value& valueOf(const Value& value) { return value; }

template <typename... Values>
inline std::u16string concat(std::u16string value, const Values&... values) {
  (value.append(toString(values)), ...);
  return value;
}

inline std::u16string toLocaleString(const BigInt& value) { return value.toString(); }
