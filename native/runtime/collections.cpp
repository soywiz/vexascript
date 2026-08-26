#include "runtime.hpp"

namespace vexa {

MapObject::MapObject() : storage_(std::make_shared<Storage>()) {}
MapObject::MapObject(MapLikeObject* dynamicBacking)
    : dynamic_backing_(dynamicBacking), storage_(std::make_shared<Storage>()) {}
MapObject::MapObject(const MapObject* source)
    : storage_(source ? source->storage_ : std::make_shared<Storage>()) {}

MapObject* MapObject::fromDynamicObject(BaseObject* backing) {
  if (!backing) throw errorAtCurrentSource(u"VexaScript value is not a compatible map");
  void* converted = backing->dynamicCast(nativeTypeToken<MapLikeObject>());
  if (!converted) throw errorAtCurrentSource(u"VexaScript value is not a compatible map");
  return Runtime::make<MapObject>(static_cast<MapLikeObject*>(converted));
}

bool MapObject::usesDynamicBacking() const { return dynamic_backing_ != nullptr; }
std::size_t MapObject::size() const {
  return dynamic_backing_ ? dynamic_backing_->dynamicMapSize() : storage_->entries.size();
}

MapObject* MapObject::set(Value key, Value value) {
  if (dynamic_backing_) { dynamic_backing_->dynamicMapSet(key, value); return this; }
  ensureUniqueStorage();
  const auto existing = storage_->index.find(key);
  if (existing != storage_->index.end()) {
    storage_->entries[existing->second].value.store(value);
    return this;
  }
  storage_->entries.push_back(Entry{StoredValue(key), StoredValue(value)});
  storage_->index.emplace(key, storage_->entries.size() - 1);
  return this;
}

std::optional<Value> MapObject::get(const Value& key) const {
  if (dynamic_backing_) return dynamic_backing_->dynamicMapGet(key);
  const auto found = storage_->index.find(key);
  return found == storage_->index.end()
      ? std::nullopt
      : std::optional<Value>(storage_->entries[found->second].value.load());
}

bool MapObject::has(const Value& key) const { return get(key).has_value(); }
bool MapObject::erase(const Value& key) {
  if (dynamic_backing_) return dynamic_backing_->dynamicMapDelete(key);
  ensureUniqueStorage();
  const auto found = storage_->index.find(key);
  if (found == storage_->index.end()) return false;
  storage_->entries.erase(storage_->entries.begin() + static_cast<std::ptrdiff_t>(found->second));
  rebuildIndex();
  return true;
}

void MapObject::clear() {
  if (dynamic_backing_) { dynamic_backing_->dynamicMapClear(); return; }
  storage_ = std::make_shared<Storage>();
}

void MapObject::forEach(const std::function<void(Value, Value, MapObject*)>& callback) {
  for (std::size_t index = 0; index < size(); ++index) {
    callback(dynamicMapValueAt(index), dynamicMapKeyAt(index), this);
  }
}

const void* MapObject::dynamicTypeToken() const { return nativeTypeToken<MapObject>(); }
void* MapObject::dynamicCast(const void* type) {
  if (type == nativeTypeToken<MapObject>()) return this;
  if (type == nativeTypeToken<MapLikeObject>()) return static_cast<MapLikeObject*>(this);
  return nullptr;
}
std::u16string MapObject::dynamicToString() const { return u"[object Map]"; }
Value MapObject::dynamicGet(const std::u16string& key) {
  if (key == u"get") {
    return Value(makeFunction<Value, Value>([this](Value lookupKey) {
      return mapGet(this, lookupKey);
    }, {Value(this)}));
  }
  return BaseObject::dynamicGet(key);
}
bool MapObject::dynamicIsIterable() const { return true; }
std::size_t MapObject::dynamicIterableSize() const { return size(); }
Value MapObject::dynamicIterableGet(std::size_t index) {
  return index < size() ? makeDynamicMapEntry(dynamicMapKeyAt(index), dynamicMapValueAt(index)) : Value::undefined();
}
std::size_t MapObject::dynamicMapSize() const { return size(); }
Value MapObject::dynamicMapKeyAt(std::size_t index) {
  if (dynamic_backing_) return dynamic_backing_->dynamicMapKeyAt(index);
  return index < storage_->entries.size() ? storage_->entries[index].key.load() : Value::undefined();
}
Value MapObject::dynamicMapValueAt(std::size_t index) {
  if (dynamic_backing_) return dynamic_backing_->dynamicMapValueAt(index);
  return index < storage_->entries.size() ? storage_->entries[index].value.load() : Value::undefined();
}
std::optional<Value> MapObject::dynamicMapGet(const Value& key) { return get(key); }
void MapObject::dynamicMapSet(const Value& key, const Value& value) { set(key, value); }
bool MapObject::dynamicMapDelete(const Value& key) { return erase(key); }
void MapObject::dynamicMapClear() { clear(); }
void MapObject::Trace(cppgc::Visitor* visitor) const {
  BaseObject::Trace(visitor);
  visitor->Trace(dynamic_backing_);
  for (const auto& entry : storage_->entries) { entry.key.Trace(visitor); entry.value.Trace(visitor); }
}
void MapObject::ensureUniqueStorage() {
  if (storage_.use_count() != 1) storage_ = std::make_shared<Storage>(*storage_);
}
void MapObject::rebuildIndex() {
  storage_->index.clear();
  for (std::size_t index = 0; index < storage_->entries.size(); ++index) {
    storage_->index.emplace(storage_->entries[index].key.load(), index);
  }
}

SetObject::SetObject() : storage_(std::make_shared<Storage>()) {}
SetObject::SetObject(const SetObject* source)
    : storage_(source ? source->storage_ : std::make_shared<Storage>()) {}
std::size_t SetObject::size() const { return storage_->values.size(); }
SetObject* SetObject::add(Value value) {
  ensureUniqueStorage();
  if (storage_->index.insert(value).second) storage_->values.emplace_back(value);
  return this;
}
bool SetObject::has(const Value& value) const { return storage_->index.contains(value); }
bool SetObject::erase(const Value& value) {
  ensureUniqueStorage();
  if (storage_->index.erase(value) == 0) return false;
  const auto found = std::find_if(storage_->values.begin(), storage_->values.end(),
      [&](const StoredValue& candidate) { return sameValueZero(candidate.load(), value); });
  if (found != storage_->values.end()) storage_->values.erase(found);
  return true;
}
void SetObject::clear() { storage_ = std::make_shared<Storage>(); }
void SetObject::forEach(const std::function<void(Value, Value, SetObject*)>& callback) {
  for (const auto& stored : storage_->values) {
    const Value value = stored.load();
    callback(value, value, this);
  }
}
const void* SetObject::dynamicTypeToken() const { return nativeTypeToken<SetObject>(); }
void* SetObject::dynamicCast(const void* type) {
  if (type == nativeTypeToken<SetObject>()) return this;
  if (type == nativeTypeToken<SetLikeObject>()) return static_cast<SetLikeObject*>(this);
  return nullptr;
}
std::u16string SetObject::dynamicToString() const { return u"[object Set]"; }
bool SetObject::dynamicIsIterable() const { return true; }
std::size_t SetObject::dynamicIterableSize() const { return size(); }
Value SetObject::dynamicIterableGet(std::size_t index) {
  return index < storage_->values.size() ? storage_->values[index].load() : Value::undefined();
}
void SetObject::Trace(cppgc::Visitor* visitor) const {
  BaseObject::Trace(visitor);
  for (const auto& value : storage_->values) value.Trace(visitor);
}
void SetObject::ensureUniqueStorage() {
  if (storage_.use_count() != 1) storage_ = std::make_shared<Storage>(*storage_);
}

WeakMapObject* WeakMapObject::set(BaseObject* key, Value value) {
  if (!key) throw runtimeError(u"Invalid WeakMap key");
  const auto existing = index_.find(key);
  if (existing != index_.end()) { entries_[existing->second]->value.store(value); return this; }
  index_.emplace(key, entries_.size());
  entries_.emplace_back(makeManaged<Entry>(key, value));
  return this;
}
std::optional<Value> WeakMapObject::get(BaseObject* key) const {
  const auto found = index_.find(key);
  return found == index_.end() ? std::nullopt : std::optional<Value>(entries_[found->second]->value.load());
}
bool WeakMapObject::has(BaseObject* key) const { return get(key).has_value(); }
bool WeakMapObject::erase(BaseObject* key) {
  const auto found = index_.find(key);
  if (found == index_.end()) return false;
  const std::size_t erasedIndex = found->second;
  index_.erase(found);
  if (erasedIndex + 1 != entries_.size()) {
    entries_[erasedIndex] = std::move(entries_.back());
    index_[entries_[erasedIndex]->key.Get()] = erasedIndex;
  }
  entries_.pop_back();
  return true;
}
const void* WeakMapObject::dynamicTypeToken() const { return nativeTypeToken<WeakMapObject>(); }
void* WeakMapObject::dynamicCast(const void* type) {
  if (type == nativeTypeToken<WeakMapObject>()) return this;
  if (type == nativeTypeToken<WeakMapLikeObject>()) return static_cast<WeakMapLikeObject*>(this);
  return nullptr;
}
std::u16string WeakMapObject::dynamicToString() const { return u"[object WeakMap]"; }
void WeakMapObject::Trace(cppgc::Visitor* visitor) const {
  BaseObject::Trace(visitor);
  for (const auto& entry : entries_) visitor->Trace(entry);
  visitor->RegisterWeakCallbackMethod<WeakMapObject, &WeakMapObject::processWeakness>(this);
}
WeakMapObject::Entry::Entry(BaseObject* keyValue, Value mappedValue) : key(keyValue), value(mappedValue) {}
void WeakMapObject::Entry::Trace(cppgc::Visitor* visitor) const { visitor->Trace(key); value.Trace(visitor); }
void WeakMapObject::processWeakness(const cppgc::LivenessBroker& broker) {
  entries_.erase(std::remove_if(entries_.begin(), entries_.end(), [&](const auto& entry) {
    return entry->key.Get() == nullptr || !broker.IsHeapObjectAlive(entry->key);
  }), entries_.end());
  index_.clear();
  for (std::size_t index = 0; index < entries_.size(); ++index) index_.emplace(entries_[index]->key.Get(), index);
}

WeakSetObject* WeakSetObject::add(BaseObject* value) {
  if (!value) throw runtimeError(u"Invalid WeakSet value");
  if (index_.insert(value).second) values_.emplace_back(makeManaged<Entry>(value));
  return this;
}
bool WeakSetObject::has(BaseObject* value) const { return index_.contains(value); }
bool WeakSetObject::erase(BaseObject* value) {
  if (index_.erase(value) == 0) return false;
  const auto found = std::find_if(values_.begin(), values_.end(),
      [&](const auto& candidate) { return candidate->value.Get() == value; });
  if (found != values_.end()) values_.erase(found);
  return true;
}
const void* WeakSetObject::dynamicTypeToken() const { return nativeTypeToken<WeakSetObject>(); }
void* WeakSetObject::dynamicCast(const void* type) {
  if (type == nativeTypeToken<WeakSetObject>()) return this;
  if (type == nativeTypeToken<WeakSetLikeObject>()) return static_cast<WeakSetLikeObject*>(this);
  return nullptr;
}
std::u16string WeakSetObject::dynamicToString() const { return u"[object WeakSet]"; }
void WeakSetObject::Trace(cppgc::Visitor* visitor) const {
  BaseObject::Trace(visitor);
  for (const auto& value : values_) visitor->Trace(value);
  visitor->RegisterWeakCallbackMethod<WeakSetObject, &WeakSetObject::processWeakness>(this);
}
WeakSetObject::Entry::Entry(BaseObject* entryValue) : value(entryValue) {}
void WeakSetObject::Entry::Trace(cppgc::Visitor* visitor) const { visitor->Trace(value); }
void WeakSetObject::processWeakness(const cppgc::LivenessBroker& broker) {
  values_.erase(std::remove_if(values_.begin(), values_.end(), [&](const auto& value) {
    return value->value.Get() == nullptr || !broker.IsHeapObjectAlive(value->value);
  }), values_.end());
  index_.clear();
  for (const auto& value : values_) index_.insert(value->value.Get());
}

bool isMapLike(const Value& value) { return value.isRuntimeObject() && isMapLike(value.object()); }
bool isSetLike(const Value& value) { return value.isRuntimeObject() && isSetLike(value.object()); }
bool isWeakMapLike(const Value& value) { return value.isRuntimeObject() && isWeakMapLike(value.object()); }
bool isWeakSetLike(const Value& value) { return value.isRuntimeObject() && isWeakSetLike(value.object()); }
bool isMapLike(BaseObject* value) { return value && value->dynamicCast(nativeTypeToken<MapLikeObject>()); }
bool isSetLike(BaseObject* value) { return value && value->dynamicCast(nativeTypeToken<SetLikeObject>()); }
bool isWeakMapLike(BaseObject* value) { return value && value->dynamicCast(nativeTypeToken<WeakMapLikeObject>()); }
bool isWeakSetLike(BaseObject* value) { return value && value->dynamicCast(nativeTypeToken<WeakSetLikeObject>()); }

Value mapGet(const MapObject* map, const Value& key) {
  const auto found = map->get(key);
  return found ? *found : Value::undefined();
}

Value mapGetValue(const MapObject* map, const Value& key) { return mapGet(map, key); }
MapObject* mapSet(MapObject* map, Value key, Value value) { return map->set(std::move(key), std::move(value)); }
bool mapHas(const MapObject* map, const Value& key) { return map->has(key); }
bool mapDelete(MapObject* map, const Value& key) { return map->erase(key); }
void mapClear(MapObject* map) { map->clear(); }
void mapForEach(MapObject* map, const std::function<void(Value, Value, MapObject*)>& callback) {
  map->forEach(callback);
}

ArrayObject<Value>* mapKeys(MapObject* map) {
  auto* result = Runtime::array<Value>();
  map->forEach([&](Value, Value key, MapObject*) { result->append(key); });
  return result;
}

ArrayObject<Value>* mapValues(MapObject* map) {
  auto* result = Runtime::array<Value>();
  map->forEach([&](Value value, Value, MapObject*) { result->append(value); });
  return result;
}

ArrayObject<ArrayObject<Value>*>* mapEntries(MapObject* map) {
  auto* result = Runtime::array<ArrayObject<Value>*>();
  map->forEach([&](Value value, Value key, MapObject*) {
    result->append(Runtime::array<Value>({key, value}));
  });
  return result;
}

ArrayObject<ArrayObject<Value>*>* mapEntries(const cppgc::Member<MapObject>& map) {
  return mapEntries(map.Get());
}

ArrayObject<ArrayObject<Value>*>* mapEntries(const cppgc::Persistent<MapObject>& map) {
  return mapEntries(map.Get());
}

MapObject* mapFromIterable(const Value& source) {
  auto* result = Runtime::make<MapObject>();
  if (source.isNull() || source.isUndefined()) return result;
  std::size_t index = 0;
  for (const Value entryValue : dynamicIterationRange(source)) {
    if (!entryValue.isRuntimeObject() || !entryValue.object()->dynamicIsArray()) {
      throw runtimeError(
          std::u16string(u"VexaScript Map entry at index ") + formatIntegerText(index) +
          u" is not an array: " + toString(entryValue));
    }
    BaseObject* entry = entryValue.object();
    if (entry->dynamicArraySize() < 2) {
      throw runtimeError(u"VexaScript Map entry must contain a key and value");
    }
    result->set(entry->dynamicArrayGet(0), entry->dynamicArrayGet(1));
    ++index;
  }
  return result;
}

SetObject* setAdd(SetObject* set, Value value) { return set->add(std::move(value)); }
bool setHas(const SetObject* set, const Value& value) { return set->has(value); }
bool setDelete(SetObject* set, const Value& value) { return set->erase(value); }
void setClear(SetObject* set) { set->clear(); }
void setForEach(SetObject* set, const std::function<void(Value, Value, SetObject*)>& callback) {
  set->forEach(callback);
}

ArrayObject<Value>* setValues(SetObject* set) {
  auto* result = Runtime::array<Value>();
  set->forEach([&](Value value, Value, SetObject*) { result->append(value); });
  return result;
}

ArrayObject<ArrayObject<Value>*>* setEntries(SetObject* set) {
  auto* result = Runtime::array<ArrayObject<Value>*>();
  set->forEach([&](Value value, Value, SetObject*) {
    result->append(Runtime::array<Value>({value, value}));
  });
  return result;
}

SetObject* setUnion(SetObject* left, SetObject* right) {
  auto* result = Runtime::make<SetObject>();
  if (left) left->forEach([&](Value value, Value, SetObject*) { result->add(value); });
  if (right) right->forEach([&](Value value, Value, SetObject*) { result->add(value); });
  return result;
}

SetObject* setIntersection(SetObject* left, SetObject* right) {
  auto* result = Runtime::make<SetObject>();
  if (!left || !right) return result;
  left->forEach([&](Value value, Value, SetObject*) { if (right->has(value)) result->add(value); });
  return result;
}

SetObject* setDifference(SetObject* left, SetObject* right) {
  auto* result = Runtime::make<SetObject>();
  if (!left) return result;
  left->forEach([&](Value value, Value, SetObject*) { if (!right || !right->has(value)) result->add(value); });
  return result;
}

SetObject* setSymmetricDifference(SetObject* left, SetObject* right) {
  auto* result = setDifference(left, right);
  if (right) right->forEach([&](Value value, Value, SetObject*) {
    if (!left || !left->has(value)) result->add(value);
  });
  return result;
}

bool setIsSubsetOf(SetObject* left, SetObject* right) {
  if (!left || !right || left->size() > right->size()) return false;
  bool result = true;
  left->forEach([&](Value value, Value, SetObject*) { result = result && right->has(value); });
  return result;
}

bool setIsSupersetOf(SetObject* left, SetObject* right) { return setIsSubsetOf(right, left); }

bool setIsDisjointFrom(SetObject* left, SetObject* right) {
  if (!left || !right) return true;
  bool result = true;
  left->forEach([&](Value value, Value, SetObject*) { result = result && !right->has(value); });
  return result;
}

SetObject* setFromIterable(const Value& source) {
  auto* result = Runtime::make<SetObject>();
  if (source.isNull() || source.isUndefined()) return result;
  for (const Value value : dynamicIterationRange(source)) result->add(value);
  return result;
}

BaseObject* weakCollectionKey(const Value& value) {
  if (!value.isObject() || value.isString()) throw runtimeError(u"Invalid weak collection key");
  return value.object();
}

WeakMapObject* weakMapFromIterable(const Value& source) {
  auto* result = Runtime::make<WeakMapObject>();
  if (source.isNull() || source.isUndefined()) return result;
  std::size_t index = 0;
  for (const Value entryValue : dynamicIterationRange(source)) {
    if (!entryValue.isRuntimeObject() || !entryValue.object()->dynamicIsArray()) {
      throw runtimeError(
          std::u16string(u"VexaScript WeakMap entry at index ") + formatIntegerText(index) +
          u" is not an array");
    }
    BaseObject* entry = entryValue.object();
    if (entry->dynamicArraySize() < 2) {
      throw runtimeError(u"VexaScript WeakMap entry must contain a key and value");
    }
    result->set(weakCollectionKey(entry->dynamicArrayGet(0)), entry->dynamicArrayGet(1));
    ++index;
  }
  return result;
}

Value weakMapGet(const WeakMapObject* map, BaseObject* key) {
  const auto found = map->get(key);
  return found ? *found : Value::undefined();
}

WeakMapObject* weakMapSet(WeakMapObject* map, BaseObject* key, Value value) {
  return map->set(key, std::move(value));
}
bool weakMapHas(const WeakMapObject* map, BaseObject* key) { return map->has(key); }
bool weakMapDelete(WeakMapObject* map, BaseObject* key) { return map->erase(key); }

WeakSetObject* weakSetFromIterable(const Value& source) {
  auto* result = Runtime::make<WeakSetObject>();
  if (source.isNull() || source.isUndefined()) return result;
  for (const Value value : dynamicIterationRange(source)) result->add(weakCollectionKey(value));
  return result;
}

WeakSetObject* weakSetAdd(WeakSetObject* set, BaseObject* value) { return set->add(value); }
bool weakSetHas(const WeakSetObject* set, BaseObject* value) { return set->has(value); }
bool weakSetDelete(WeakSetObject* set, BaseObject* value) { return set->erase(value); }

}  // namespace vexa
