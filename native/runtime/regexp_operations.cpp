#include "runtime.hpp"

namespace vexa {

ArrayObject<Value>* regexExec(const RegExp& expression, const std::u16string& value) {
  const auto captures = expression.exec(value);
  if (!captures) return nullptr;
  auto* result = Runtime::array<Value>();
  for (const auto& capture : *captures) result->append(Runtime::string(capture));
  return result;
}

ArrayObject<Value>* regexExec(const RegExp& expression, const Value& value) {
  return regexExec(expression, value.isString() ? value.string() : std::u16string());
}

ArrayObject<Value>* stringMatch(const std::u16string& value, const RegExp& expression) {
  return regexExec(expression, value);
}

ArrayObject<ArrayObject<Value>*>* stringMatchAll(
    const std::u16string& value,
    const RegExp& expression) {
  if (!expression.global) throw runtimeError(u"String.matchAll requires a global regular expression");
  auto* result = Runtime::array<ArrayObject<Value>*>();
  for (const auto& captures : expression.execAll(value)) {
    auto* match = Runtime::array<Value>();
    for (const auto& capture : captures) match->append(Runtime::string(capture));
    result->append(match);
  }
  return result;
}

double stringSearch(const std::u16string& value, const RegExp& expression) {
  return expression.search(value);
}

}  // namespace vexa
