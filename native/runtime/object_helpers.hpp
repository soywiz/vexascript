#pragma once

// Internal runtime category header. Include runtime.hpp instead.

template <typename T>
inline T* rawPointer(T* value) {
  return value;
}

template <typename T>
inline T* rawPointer(const cppgc::Member<T>& value) {
  return value.Get();
}

template <typename T>
inline T* rawPointer(const cppgc::Persistent<T>& value) {
  return value.Get();
}

BaseObject* rawPointer(const Value& value);

template <typename Target, typename Callback>
inline Value optionalCall(Target* target, Callback&& callback) {
  if (!target) return Value::undefined();
  using Result = std::invoke_result_t<Callback, Target*>;
  if constexpr (std::is_void_v<Result>) {
    std::forward<Callback>(callback)(target);
    return Value::undefined();
  } else {
    return convertValue<Value>(std::forward<Callback>(callback)(target));
  }
}

template <typename Callback>
inline Value optionalCall(const Value& target, Callback&& callback) {
  if (target.isUndefined() || target.isNull()) return Value::undefined();
  using Result = std::invoke_result_t<Callback, const Value&>;
  if constexpr (std::is_void_v<Result>) {
    std::forward<Callback>(callback)(target);
    return Value::undefined();
  } else {
    return convertValue<Value>(std::forward<Callback>(callback)(target));
  }
}

template <typename T>
inline void defineProperty(
    T&& object,
    std::u16string key,
    const Value& value,
    bool enumerable,
    bool writable = false,
    bool configurable = false) {
  using Input = std::remove_cvref_t<T>;
  if constexpr (std::is_same_v<Input, Value>) {
    if (object.isRecord()) {
      object.record()->define(std::move(key), value, enumerable, writable, configurable);
    } else if (object.isRuntimeObject()) {
      object.object()->dynamicDefineProperty(key, value, enumerable);
    } else {
      throw runtimeError(u"Native Object.defineProperty requires an object");
    }
  } else {
    auto* pointer = rawPointer(std::forward<T>(object));
    using Object = std::remove_pointer_t<decltype(pointer)>;
    if constexpr (std::is_same_v<Object, RecordObject>) {
      if (!pointer) throw runtimeError(u"Cannot define a property on null");
      pointer->define(std::move(key), value, enumerable, writable, configurable);
    } else if constexpr (std::is_base_of_v<BaseObject, Object>) {
      if (!pointer) throw runtimeError(u"Cannot define a property on null");
      pointer->dynamicDefineProperty(key, value, enumerable);
    } else if constexpr (std::is_base_of_v<EnumerableObject, Object>) {
      if (!pointer) throw runtimeError(u"Cannot define a property on null");
      pointer->defineProperty(key, value, enumerable);
    } else {
      throw runtimeError(u"Native Object.defineProperty requires an enumerable native object");
    }
  }
}
