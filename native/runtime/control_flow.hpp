#pragma once

// Internal runtime category header. Include runtime.hpp instead.

template <typename Callback>
Value nullishCoalesce(Value value, Callback&& fallback) {
  return value.isNull() || value.isUndefined()
      ? toValue(std::forward<Callback>(fallback)())
      : value;
}

template <typename Callback>
std::u16string nullishCoalesce(std::u16string value, Callback&&) {
  return value;
}

template <typename T, typename Callback>
T* nullishCoalesce(T* value, Callback&& fallback) {
  if (value) return value;
  return convertValue<T*>(std::forward<Callback>(fallback)());
}

template <typename T, typename Callback>
T* nullishCoalesce(const cppgc::Member<T>& value, Callback&& fallback) {
  if (value) return value.Get();
  return convertValue<T*>(std::forward<Callback>(fallback)());
}

template <typename T, typename Callback>
T nullishCoalesce(std::optional<T> value, Callback&& fallback) {
  return value.has_value() ? std::move(*value) : std::forward<Callback>(fallback)();
}

template <typename T>
std::vector<T> range(T start, T end, bool exclusive) {
  std::vector<T> values;
  for (T current = start; exclusive ? current < end : current <= end; ++current) {
    values.push_back(current);
  }
  return values;
}
