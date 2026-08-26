#pragma once

// Internal runtime category header. Include runtime.hpp instead.

inline const std::u16string& propertyKey(const std::u16string& value) { return value; }
inline std::u16string propertyKey(double value) {
  return formatNumberText(value);
}
inline std::u16string propertyKey(std::int32_t value) { return formatIntegerText(value); }
inline std::u16string propertyKey(std::int64_t value) { return formatIntegerText(value); }
inline std::u16string propertyKey(const BigInt& value) { return value.toString(); }
inline std::u16string propertyKey(bool value) { return value ? u"true" : u"false"; }
inline std::u16string propertyKey(const Value& value) {
  if (value.isString()) return value.utf16();
  if (value.isNumber()) return propertyKey(value.number());
  if (value.isBigInt()) return propertyKey(value.bigint());
  if (value.isBoolean()) return propertyKey(value.boolean());
  if (value.isNull()) return u"null";
  if (value.isUndefined()) return u"undefined";
  if (value.isRuntimeObject()) return value.object()->dynamicToString();
  return u"[object Object]";
}

template <typename Callback, typename T>
inline decltype(auto) invokeGroupByCallback(Callback& callback, T value, std::size_t index) {
  if constexpr (std::is_invocable_v<Callback, T, double>) {
    return callback(value, static_cast<double>(index));
  } else {
    return callback(value);
  }
}

template <typename T, typename Callback>
inline RecordObject* objectGroupBy(const ArrayObject<T>* items, Callback callback) {
  auto* result = Runtime::record();
  if (!items) return result;
  for (std::size_t index = 0; index < items->size(); ++index) {
    const T value = items->get(index);
    const auto key = propertyKey(invokeGroupByCallback(callback, value, index));
    const Value existing = result->get(key);
    ArrayObject<T>* group = existing.isUndefined()
        ? Runtime::array<T>()
        : convertValue<ArrayObject<T>*>(existing);
    if (existing.isUndefined()) result->set(key, convertValue<Value>(group));
    group->append(value);
  }
  return result;
}

template <typename T, typename Callback>
inline auto mapGroupBy(const ArrayObject<T>* items, Callback callback) {
  using K = std::remove_cvref_t<decltype(invokeGroupByCallback(callback, std::declval<T>(), 0))>;
  auto* result = Runtime::make<MapObject<K, ArrayObject<T>*>>();
  if (!items) return result;
  for (std::size_t index = 0; index < items->size(); ++index) {
    const T value = items->get(index);
    K key = invokeGroupByCallback(callback, value, index);
    const auto existing = result->get(key);
    ArrayObject<T>* group = existing ? *existing : Runtime::array<T>();
    if (!existing) result->set(key, group);
    group->append(value);
  }
  return result;
}
