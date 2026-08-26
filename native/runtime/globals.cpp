#include "runtime.hpp"

namespace vexa {

Runtime::TimerId setTimeout(Runtime::TimerCallback callback, double delay) {
  return Runtime::setTimeout(std::move(callback), delay);
}

Runtime::TimerId setInterval(Runtime::TimerCallback callback, double delay) {
  return Runtime::setInterval(std::move(callback), delay);
}

void clearTimeout(Runtime::TimerId id) { Runtime::clearTimeout(id); }

void clearInterval(Runtime::TimerId id) { Runtime::clearInterval(id); }

void clearTimeout(const Value& id) { Runtime::clearTimeout(id); }

void clearInterval(const Value& id) { Runtime::clearInterval(id); }

Value call(const Value& callable, std::initializer_list<Value> arguments) {
  return call(callable, std::vector<Value>(arguments));
}

Value callOptional(const Value& callable, std::initializer_list<Value> arguments) {
  return callOptional(callable, std::vector<Value>(arguments));
}

std::u16string typeOf(const Value& value) {
  if (value.isUndefined()) return u"undefined";
  if (value.isBoolean()) return u"boolean";
  if (value.isNumber()) return u"number";
  if (value.isBigInt()) return u"bigint";
  if (value.isString()) return u"string";
  if (value.isRuntimeObject() && value.object()->dynamicToString() == u"function") return u"function";
  return u"object";
}

std::u16string typeOf(double) { return u"number"; }

std::u16string typeOf(const BigInt&) { return u"bigint"; }

std::u16string typeOf(bool) { return u"boolean"; }

std::u16string typeOf(const std::u16string&) { return u"string"; }

}  // namespace vexa
