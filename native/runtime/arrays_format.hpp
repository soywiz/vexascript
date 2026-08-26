#pragma once

// Internal runtime category header. Include runtime.hpp instead.

inline std::u16string concatText(std::initializer_list<std::u16string_view> parts) {
  std::size_t size = 0;
  for (const auto part : parts) size += part.size();
  std::u16string result;
  result.reserve(size);
  for (const auto part : parts) result.append(part);
  return result;
}

template <typename T, typename Callback, typename Separator>
inline std::u16string mapJoin(
    const ArrayObject<T>* array,
    Callback callback,
    Separator&& rawSeparator) {
  const std::u16string separator = toString(std::forward<Separator>(rawSeparator));
  std::vector<std::u16string> parts;
  parts.reserve(array->size());
  std::size_t resultSize = array->size() > 0 ? separator.size() * (array->size() - 1) : 0;
  for (std::size_t index = 0; index < array->size(); ++index) {
    parts.push_back(toString(invokeArrayCallback(callback, array->get(index), index, array)));
    resultSize += parts.back().size();
  }
  std::u16string result;
  result.reserve(resultSize);
  for (std::size_t index = 0; index < parts.size(); ++index) {
    if (index > 0) result += separator;
    result += parts[index];
  }
  return result;
}

template <typename T>
inline std::u16string joinWithSeparator(const std::vector<T>& array, const std::u16string& separator) {
  std::u16string output;
  for (std::size_t index = 0; index < array.size(); ++index) {
    if (index > 0) output += separator;
    output += toString(array[index]);
  }
  return output;
}

template <typename T>
inline std::u16string joinWithSeparator(const ArrayObject<T>* array, const std::u16string& separator) {
  std::u16string output;
  for (std::size_t index = 0; index < array->size(); ++index) {
    if (index > 0) output += separator;
    output += toString(array->get(index));
  }
  return output;
}

template <typename T>
inline std::u16string ArrayObject<T>::join(const std::u16string& separator) const {
  if constexpr (std::is_same_v<T, std::u16string>) {
    if (!dynamic_backing_) {
      if (values_.empty()) return {};
      std::size_t outputSize = separator.size() * (values_.size() - 1);
      for (const auto& value : values_) outputSize += value.loadRef().size();
      std::u16string output;
      output.reserve(outputSize);
      for (std::size_t index = 0; index < values_.size(); ++index) {
        if (index > 0) output += separator;
        output += values_[index].loadRef();
      }
      return output;
    }
  }
  return joinWithSeparator(this, separator);
}

template <typename T>
inline std::u16string join(const std::vector<T>& array) {
  return joinWithSeparator(array, u",");
}

template <typename T>
inline std::u16string join(const ArrayObject<T>* array) {
  return array->join();
}

inline std::u16string join(const std::vector<std::u16string>& array, const std::u16string& separator) {
  if (array.empty()) return std::u16string();
  std::size_t size = separator.size() * (array.size() - 1);
  for (const auto& value : array) size += value.size();
  std::u16string result;
  result.reserve(size);
  for (std::size_t index = 0; index < array.size(); ++index) {
    if (index > 0) result += separator;
    result += array[index];
  }
  return result;
}

inline std::u16string join(const ArrayObject<std::u16string>* array, const std::u16string& separator) {
  return array ? array->join(separator) : std::u16string();
}

template <typename T, typename Separator>
inline std::u16string join(const std::vector<T>& array, const Separator& separator) {
  return joinWithSeparator(array, toString(separator));
}

template <typename T, typename Separator>
inline std::u16string join(const ArrayObject<T>* array, const Separator& separator) {
  return array->join(toString(separator));
}

template <typename T>
inline std::u16string ArrayObject<T>::toString() const {
  return std::u16string(u"[") + join(u", ") + u"]";
}

template <typename T>
inline std::u16string toLocaleString(const ArrayObject<T>* array) {
  return array->toLocaleString();
}

template <typename T>
inline ArrayObject<T>* ArrayObject<T>::sort() {
  std::vector<T> sorted;
  sorted.reserve(size());
  for (std::size_t index = 0; index < size(); ++index) sorted.push_back(get(index));
  std::stable_sort(sorted.begin(), sorted.end(), [](const T& left, const T& right) {
    return vexa::toString(left) < vexa::toString(right);
  });
  for (std::size_t index = 0; index < sorted.size(); ++index) {
    values_[index].store(std::move(sorted[index]));
  }
  return this;
}

template <typename T>
inline ArrayObject<T>* sort(ArrayObject<T>* array) {
  return array->sort();
}

template <typename T>
inline std::u16string toString(ArrayObject<T>* array) {
  return array ? array->toString() : u"null";
}

template <typename T>
inline std::u16string toString(const cppgc::Member<ArrayObject<T>>& array) {
  return toString(array.Get());
}

template <typename T>
inline std::u16string toString(const cppgc::Persistent<ArrayObject<T>>& array) {
  return toString(array.Get());
}
