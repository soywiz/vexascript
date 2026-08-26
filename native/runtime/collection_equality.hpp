#pragma once

// Internal runtime category header. Include runtime.hpp instead.

template <typename Left, typename Right>
inline bool sameValueZero(const Left& left, const Right& right) {
  return left == right;
}

inline bool sameValueZero(double left, double right) {
  return left == right || (std::isnan(left) && std::isnan(right));
}

inline bool sameValueZero(const Value& left, const Value& right) {
  return left == right || (left.isNumber() && right.isNumber() &&
      std::isnan(left.number()) && std::isnan(right.number()));
}

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
  std::size_t operator()(const Value& value) const {
    if (value.isUndefined()) return 0x11;
    if (value.isNull()) return 0x23;
    if (value.isBoolean()) return value.boolean() ? 0x37 : 0x41;
    if (value.isNumber()) {
      if (std::isnan(value.number())) return 0x53;
      const double normalized = value.number() == 0 ? 0 : value.number();
      return std::hash<double>{}(normalized) ^ 0x67;
    }
    if (value.isBigInt()) {
      return std::hash<std::u16string>{}(value.bigint().toString()) ^ 0x79;
    }
    if (value.isString()) return std::hash<std::u16string>{}(value.utf16()) ^ 0x83;
    if (value.isRecord()) return std::hash<const void*>{}(value.record()) ^ 0x97;
    return std::hash<const void*>{}(value.object()) ^ 0xa9;
  }
};

template <typename T>
struct SameValueZeroEqual final {
  bool operator()(const T& left, const T& right) const {
    return sameValueZero(left, right);
  }
};
