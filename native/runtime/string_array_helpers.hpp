#pragma once

// Internal runtime category header. Include runtime.hpp instead.

bool includes(const std::vector<std::u16string>& array, const Value& value);

bool includes(const ArrayObject<std::u16string>* array, const Value& value);

double indexOf(const std::vector<std::u16string>& array, const Value& value);

double indexOf(const ArrayObject<std::u16string>* array, const Value& value);

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
