#include "runtime.hpp"

namespace vexa {

ArrayObject<RecordObject*>* arrayFrom(const IntlSegmentsObject* source) {
  return source ? source->items()->slice() : Runtime::array<RecordObject*>();
}

RecordObject* makeRecord(
    std::initializer_list<std::pair<std::u16string, Value>> properties) {
  return Runtime::record(properties);
}

RecordObject* RecordObject::descriptor(const std::u16string& key) const {
  if (!has(key)) return nullptr;
  auto* result = Runtime::record();
  result->set(u"value", get(key));
  result->set(u"writable", Value(!writable_properties_.contains(key) || writable_properties_.at(key)));
  result->set(u"enumerable", Value(propertyIsEnumerable(key)));
  result->set(u"configurable", Value(!configurable_properties_.contains(key) || configurable_properties_.at(key)));
  return result;
}

Value makeString(std::u16string value) {
  return Runtime::string(std::move(value));
}

ArrayObject<Value>* makeDynamicArrayValueView(BaseObject* backing) {
  return Runtime::make<ArrayObject<Value>>(backing);
}

RecordObject* makeDynamicPropertyRecord() {
  return Runtime::record();
}

std::runtime_error errorAtCurrentSource(std::u16string message) {
  return Runtime::errorAtCurrentSource(std::move(message));
}

Value makeDynamicMapEntry(Value key, Value value) {
  auto* pair = Runtime::array<Value>();
  pair->append(std::move(key));
  pair->append(std::move(value));
  return Value(pair);
}

}  // namespace vexa
