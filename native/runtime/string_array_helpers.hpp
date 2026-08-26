#pragma once

// Internal runtime category header. Include runtime.hpp instead.

inline bool includes(const std::vector<std::u16string>& array, const Value& value) {
  return includes(array, toString(value));
}

inline bool includes(const ArrayObject<std::u16string>* array, const Value& value) {
  return includes(array, toString(value));
}

inline double indexOf(const std::vector<std::u16string>& array, const Value& value) {
  return indexOf(array, toString(value));
}

inline double indexOf(const ArrayObject<std::u16string>* array, const Value& value) {
  return indexOf(array, toString(value));
}

template <typename... Values>
inline double push(std::vector<std::u16string>& array, Values&&... values) {
  (array.push_back(toString(std::forward<Values>(values))), ...);
  return static_cast<double>(array.size());
}

template <typename... Values>
inline double push(ArrayObject<std::u16string>* array, Values&&... values) {
  (array->append(toString(std::forward<Values>(values))), ...);
  return static_cast<double>(array->size());
}
