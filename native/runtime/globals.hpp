#pragma once

// Internal runtime category header. Include runtime.hpp instead.

template <typename T, typename Executor>
inline Task<T> createTask(Executor executor) {
  return Task<T>::create(std::move(executor));
}

inline Runtime::TimerId setTimeout(Runtime::TimerCallback callback, double delay = 0) {
  return Runtime::setTimeout(std::move(callback), delay);
}

inline Runtime::TimerId setInterval(Runtime::TimerCallback callback, double delay = 0) {
  return Runtime::setInterval(std::move(callback), delay);
}

inline void clearTimeout(Runtime::TimerId id) { Runtime::clearTimeout(id); }
inline void clearInterval(Runtime::TimerId id) { Runtime::clearInterval(id); }
inline void clearTimeout(const Value& id) { Runtime::clearTimeout(id); }
inline void clearInterval(const Value& id) { Runtime::clearInterval(id); }

inline Value call(const Value& callable, std::initializer_list<Value> arguments) {
  return call(callable, std::vector<Value>(arguments));
}

inline Value callOptional(const Value& callable, std::initializer_list<Value> arguments) {
  return callOptional(callable, std::vector<Value>(arguments));
}

inline std::u16string typeOf(const Value& value) {
  if (value.isUndefined()) return u"undefined";
  if (value.isBoolean()) return u"boolean";
  if (value.isNumber()) return u"number";
  if (value.isBigInt()) return u"bigint";
  if (value.isString()) return u"string";
  if (value.isRuntimeObject() && value.object()->dynamicToString() == u"function") return u"function";
  return u"object";
}
inline std::u16string typeOf(double) { return u"number"; }
inline std::u16string typeOf(const BigInt&) { return u"bigint"; }
inline std::u16string typeOf(bool) { return u"boolean"; }
inline std::u16string typeOf(const std::u16string&) { return u"string"; }
