#include "runtime.hpp"

namespace vexa {

template <>
Value defaultValue<Value>() {
  return Value::undefined();
}

}  // namespace vexa
