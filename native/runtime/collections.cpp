#include "runtime.hpp"

namespace vexa {

bool isMapLike(const Value& value) { return isCollectionLikeValue<MapLikeObject>(value); }

bool isSetLike(const Value& value) { return isCollectionLikeValue<SetLikeObject>(value); }

bool isWeakMapLike(const Value& value) { return isCollectionLikeValue<WeakMapLikeObject>(value); }

bool isWeakSetLike(const Value& value) { return isCollectionLikeValue<WeakSetLikeObject>(value); }

}  // namespace vexa
