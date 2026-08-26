#include "runtime.hpp"

namespace vexa {

BaseObject* rawPointer(const Value& value) {
  return value.isRuntimeObject() ? value.object() : nullptr;
}

}  // namespace vexa
