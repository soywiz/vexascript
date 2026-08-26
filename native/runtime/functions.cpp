#include "runtime.hpp"

namespace vexa {

Value call(const Value& callable, std::vector<Value> arguments) {
  if (!callable.isRuntimeObject()) {
    throw errorAtCurrentSource(u"VexaScript value is not callable");
  }
  return callable.object()->dynamicCall(arguments);
}

Value callOptional(const Value& callable, std::vector<Value> arguments) {
  if (callable.isNull() || callable.isUndefined()) return Value::undefined();
  return call(callable, std::move(arguments));
}

}  // namespace vexa
