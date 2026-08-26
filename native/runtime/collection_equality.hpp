#pragma once

// Internal runtime category header. Include runtime.hpp instead.

template <typename Left, typename Right>
inline bool sameValueZero(const Left& left, const Right& right) {
  return left == right;
}

bool sameValueZero(double left, double right);

bool sameValueZero(const Value& left, const Value& right);

template <typename T>
struct SameValueZeroHash final {
  std::size_t operator()(const T& value) const {
    if constexpr (std::is_same_v<T, BigInt>) {
      return std::hash<std::u16string>{}(value.toString());
    } else if constexpr (std::is_same_v<T, std::u16string>) {
      return std::hash<std::u16string>{}(value);
    } else if constexpr (std::is_pointer_v<T>) {
      return std::hash<const void*>{}(value);
    } else {
      return std::hash<T>{}(value);
    }
  }
};

template <>
struct SameValueZeroHash<Value> final {
  std::size_t operator()(const Value& value) const;
};

template <typename T>
struct SameValueZeroEqual final {
  bool operator()(const T& left, const T& right) const {
    return sameValueZero(left, right);
  }
};
