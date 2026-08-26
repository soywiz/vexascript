#include "runtime.hpp"

namespace vexa {

Value ArraySlot<Value>::load() const { return value_.load(); }

void ArraySlot<Value>::store(Value value) { value_.store(value); }

void ArraySlot<Value>::Trace(cppgc::Visitor* visitor) const { value_.Trace(visitor); }


ArraySlot<Value>::ArraySlot() = default;

ArraySlot<Value>::ArraySlot(Value value) : value_(value) {}
}  // namespace vexa
