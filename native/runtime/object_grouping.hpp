#pragma once

// Internal runtime category header. Include runtime.hpp instead.

const std::u16string& propertyKey(const std::u16string& value);
std::u16string propertyKey(double value);
std::u16string propertyKey(std::int32_t value);
std::u16string propertyKey(std::int64_t value);
std::u16string propertyKey(const BigInt& value);
std::u16string propertyKey(bool value);
std::u16string propertyKey(const Value& value);

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
inline MapObject* mapGroupBy(const ArrayObject<T>* items, Callback callback) {
  auto* result = Runtime::make<MapObject>();
  if (!items) return result;
  for (std::size_t index = 0; index < items->size(); ++index) {
    const T value = items->get(index);
    Value key = toValue(invokeGroupByCallback(callback, value, index));
    const auto existing = result->get(key);
    ArrayObject<T>* group = existing
        ? convertValue<ArrayObject<T>*>(*existing)
        : Runtime::array<T>();
    if (!existing) result->set(key, toValue(group));
    group->append(value);
  }
  return result;
}
