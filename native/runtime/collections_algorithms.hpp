#pragma once

// Internal runtime category header. Include runtime.hpp instead.

template <typename T, typename Callback>
T& nullishAssign(T& target, Callback&& fallback) {
  if constexpr (std::is_same_v<T, Value>) {
    if (target.isNull() || target.isUndefined()) target = std::forward<Callback>(fallback)();
  } else if constexpr (std::is_pointer_v<T>) {
    if (!target) target = std::forward<Callback>(fallback)();
  } else if constexpr (requires(T& persistent) { persistent.Get(); }) {
    if (!target.Get()) target = std::forward<Callback>(fallback)();
  }
  return target;
}

Value mapGet(const MapObject* map, const Value& key);
Value mapGetValue(const MapObject* map, const Value& key);
MapObject* mapSet(MapObject* map, Value key, Value value);
bool mapHas(const MapObject* map, const Value& key);
bool mapDelete(MapObject* map, const Value& key);
void mapClear(MapObject* map);

void mapForEach(MapObject* map, const std::function<void(Value, Value, MapObject*)>& callback);

ArrayObject<Value>* mapKeys(MapObject* map);
ArrayObject<Value>* mapValues(MapObject* map);
ArrayObject<ArrayObject<Value>*>* mapEntries(MapObject* map);
ArrayObject<ArrayObject<Value>*>* mapEntries(const cppgc::Member<MapObject>& map);
ArrayObject<ArrayObject<Value>*>* mapEntries(const cppgc::Persistent<MapObject>& map);
MapObject* mapFromIterable(const Value& source);

SetObject* setAdd(SetObject* set, Value value);
bool setHas(const SetObject* set, const Value& value);
bool setDelete(SetObject* set, const Value& value);
void setClear(SetObject* set);

void setForEach(SetObject* set, const std::function<void(Value, Value, SetObject*)>& callback);

ArrayObject<Value>* setValues(SetObject* set);
ArrayObject<ArrayObject<Value>*>* setEntries(SetObject* set);
SetObject* setUnion(SetObject* left, SetObject* right);
SetObject* setIntersection(SetObject* left, SetObject* right);
SetObject* setDifference(SetObject* left, SetObject* right);
SetObject* setSymmetricDifference(SetObject* left, SetObject* right);
bool setIsSubsetOf(SetObject* left, SetObject* right);
bool setIsSupersetOf(SetObject* left, SetObject* right);
bool setIsDisjointFrom(SetObject* left, SetObject* right);
SetObject* setFromIterable(const Value& source);

WeakMapObject* weakMapFromIterable(const Value& source);
BaseObject* weakCollectionKey(const Value& value);
Value weakMapGet(const WeakMapObject* map, BaseObject* key);
WeakMapObject* weakMapSet(WeakMapObject* map, BaseObject* key, Value value);
bool weakMapHas(const WeakMapObject* map, BaseObject* key);
bool weakMapDelete(WeakMapObject* map, BaseObject* key);

WeakSetObject* weakSetFromIterable(const Value& source);
WeakSetObject* weakSetAdd(WeakSetObject* set, BaseObject* value);
bool weakSetHas(const WeakSetObject* set, BaseObject* value);
bool weakSetDelete(WeakSetObject* set, BaseObject* value);
