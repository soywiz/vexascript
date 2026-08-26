#pragma once

// Internal runtime category header. Include runtime.hpp instead.

class MapLikeObject : public BaseObject {
 public:
  virtual std::size_t dynamicMapSize() const = 0;
  virtual Value dynamicMapKeyAt(std::size_t) = 0;
  virtual Value dynamicMapValueAt(std::size_t) = 0;
  virtual std::optional<Value> dynamicMapGet(const Value&) = 0;
  virtual void dynamicMapSet(const Value&, const Value&) = 0;
  virtual bool dynamicMapDelete(const Value&) = 0;
  virtual void dynamicMapClear() = 0;
};
class SetLikeObject : public BaseObject {};
class WeakMapLikeObject : public BaseObject {};
class WeakSetLikeObject : public BaseObject {};

template <typename K, typename V>
class MapObject final : public cppgc::GarbageCollected<MapObject<K, V>>, public MapLikeObject {
 private:
  struct Entry final {
    ArraySlot<K> key;
    ArraySlot<V> value;
  };
  struct Storage final {
    std::vector<Entry> entries;
    std::unordered_map<K, std::size_t, SameValueZeroHash<K>, SameValueZeroEqual<K>> index;
  };

 public:
  MapObject() : storage_(std::make_shared<Storage>()) {}
  explicit MapObject(MapLikeObject* dynamicBacking) : dynamic_backing_(dynamicBacking) {}
  explicit MapObject(const MapObject* source) : storage_(source->storage_) {}
  static MapObject* fromDynamicObject(BaseObject* backing);

  bool usesDynamicBacking() const { return dynamic_backing_ != nullptr; }
  std::size_t size() const { return dynamic_backing_ ? dynamic_backing_->dynamicMapSize() : storage_->entries.size(); }

  MapObject* set(K key, V value) {
    if (dynamic_backing_) {
      dynamic_backing_->dynamicMapSet(
          convertValue<Value>(key),
          convertValue<Value>(value));
      return this;
    }
    ensureUniqueStorage();
    const auto existing = storage_->index.find(key);
    if (existing != storage_->index.end()) {
      storage_->entries[existing->second].value.store(std::move(value));
      return this;
    }
    storage_->entries.push_back(Entry{ArraySlot<K>(std::move(key)), ArraySlot<V>(std::move(value))});
    storage_->index.emplace(storage_->entries.back().key.load(), storage_->entries.size() - 1);
    return this;
  }

  std::optional<V> get(const K& key) const {
    if (dynamic_backing_) {
      const auto found = dynamic_backing_->dynamicMapGet(convertValue<Value>(key));
      if (!found) return std::nullopt;
      try {
        return std::optional<V>(convertValue<V>(*found));
      } catch (const std::runtime_error& error) {
        throw runtimeError(
            utf8ToUtf16(error.what()) + u" while reading Map key " +
            toString(convertValue<Value>(key)));
      }
    }
    const auto found = storage_->index.find(key);
    return found == storage_->index.end()
        ? std::nullopt
        : std::optional<V>(storage_->entries[found->second].value.load());
  }

  bool has(const K& key) const {
    return dynamic_backing_
      ? dynamic_backing_->dynamicMapGet(convertValue<Value>(key)).has_value()
      : storage_->index.contains(key);
  }

  bool erase(const K& key) {
    if (dynamic_backing_) {
      return dynamic_backing_->dynamicMapDelete(convertValue<Value>(key));
    }
    ensureUniqueStorage();
    const auto found = storage_->index.find(key);
    if (found == storage_->index.end()) return false;
    const std::size_t erasedIndex = found->second;
    storage_->entries.erase(storage_->entries.begin() + static_cast<std::ptrdiff_t>(erasedIndex));
    rebuildIndex(erasedIndex);
    return true;
  }

  void clear() {
    if (dynamic_backing_) {
      dynamic_backing_->dynamicMapClear();
      return;
    }
    storage_ = std::make_shared<Storage>();
  }

  template <typename Callback>
  void forEach(Callback callback) {
    if (dynamic_backing_) {
            for (std::size_t index = 0; index < dynamic_backing_->dynamicMapSize(); ++index) {
        const K key = convertValue<K>(dynamic_backing_->dynamicMapKeyAt(index));
        const V value = convertValue<V>(dynamic_backing_->dynamicMapValueAt(index));
        if constexpr (std::is_invocable_v<Callback, V, K, MapObject*>) callback(value, key, this);
        else if constexpr (std::is_invocable_v<Callback, V, K>) callback(value, key);
        else callback(value);
      }
      return;
    }
    for (const auto& entry : storage_->entries) {
      if constexpr (std::is_invocable_v<Callback, V, K, MapObject*>) {
        callback(entry.value.load(), entry.key.load(), this);
      } else if constexpr (std::is_invocable_v<Callback, V, K>) {
        callback(entry.value.load(), entry.key.load());
      } else {
        callback(entry.value.load());
      }
    }
  }

  const void* dynamicTypeToken() const override { return nativeTypeToken<MapObject<K, V>>(); }
  void* dynamicCast(const void* type) override {
    if (type == nativeTypeToken<MapObject<K, V>>()) return this;
    if (type == nativeTypeToken<MapLikeObject>()) return static_cast<MapLikeObject*>(this);
    return nullptr;
  }
  std::u16string dynamicToString() const override { return u"[object Map]"; }
  bool dynamicIsIterable() const override { return true; }
  std::size_t dynamicIterableSize() const override { return size(); }
  Value dynamicIterableGet(std::size_t index) override {
    if (index >= size()) return Value::undefined();
    return makeDynamicMapEntry(
        dynamicMapKeyAt(index),
        dynamicMapValueAt(index));
  }

  std::size_t dynamicMapSize() const override { return size(); }
  Value dynamicMapKeyAt(std::size_t index) override {
    if (dynamic_backing_) return dynamic_backing_->dynamicMapKeyAt(index);
    return index < storage_->entries.size() ? convertValue<Value>(storage_->entries[index].key.load()) : Value::undefined();
  }
  Value dynamicMapValueAt(std::size_t index) override {
    if (dynamic_backing_) return dynamic_backing_->dynamicMapValueAt(index);
    return index < storage_->entries.size() ? convertValue<Value>(storage_->entries[index].value.load()) : Value::undefined();
  }
  std::optional<Value> dynamicMapGet(const Value& key) override {
    if (dynamic_backing_) return dynamic_backing_->dynamicMapGet(key);
    const auto found = get(convertValue<K>(key));
    return found ? std::optional<Value>(convertValue<Value>(*found)) : std::nullopt;
  }
  void dynamicMapSet(const Value& key, const Value& value) override {
    if (dynamic_backing_) {
      dynamic_backing_->dynamicMapSet(key, value);
      return;
    }
    set(convertValue<K>(key), convertValue<V>(value));
  }
  bool dynamicMapDelete(const Value& key) override {
    return dynamic_backing_
      ? dynamic_backing_->dynamicMapDelete(key)
      : erase(convertValue<K>(key));
  }
  void dynamicMapClear() override { clear(); }

  void Trace(cppgc::Visitor* visitor) const override {
    BaseObject::Trace(visitor);
    visitor->Trace(dynamic_backing_);
    for (const auto& entry : storage_->entries) {
      entry.key.Trace(visitor);
      entry.value.Trace(visitor);
    }
  }

 private:
  void ensureUniqueStorage() {
    if (storage_.use_count() != 1) storage_ = std::make_shared<Storage>(*storage_);
  }
  void rebuildIndex(std::size_t) {
    storage_->index.clear();
    for (std::size_t index = 0; index < storage_->entries.size(); ++index) {
      storage_->index.emplace(storage_->entries[index].key.load(), index);
    }
  }
  cppgc::Member<MapLikeObject> dynamic_backing_;
  std::shared_ptr<Storage> storage_ = std::make_shared<Storage>();
};

template <typename T>
class SetObject final : public cppgc::GarbageCollected<SetObject<T>>, public SetLikeObject {
 private:
  struct Storage final {
    std::vector<ArraySlot<T>> values;
    std::unordered_set<T, SameValueZeroHash<T>, SameValueZeroEqual<T>> index;
  };

 public:
  SetObject() : storage_(std::make_shared<Storage>()) {}
  explicit SetObject(const SetObject* source) : storage_(source->storage_) {}

  std::size_t size() const { return storage_->values.size(); }

  SetObject* add(T value) {
    ensureUniqueStorage();
    if (storage_->index.insert(value).second) storage_->values.emplace_back(std::move(value));
    return this;
  }

  bool has(const T& value) const {
    return storage_->index.contains(value);
  }

  bool erase(const T& value) {
    ensureUniqueStorage();
    if (storage_->index.erase(value) == 0) return false;
    const auto found = std::find_if(storage_->values.begin(), storage_->values.end(), [&](const ArraySlot<T>& candidate) {
      return sameValueZero(candidate.load(), value);
    });
    if (found == storage_->values.end()) return true;
    storage_->values.erase(found);
    return true;
  }

  void clear() {
    storage_ = std::make_shared<Storage>();
  }

  template <typename Callback>
  void forEach(Callback callback) {
    for (const auto& value : storage_->values) {
      if constexpr (std::is_invocable_v<Callback, T, T, SetObject*>) {
        callback(value.load(), value.load(), this);
      } else if constexpr (std::is_invocable_v<Callback, T, T>) {
        callback(value.load(), value.load());
      } else {
        callback(value.load());
      }
    }
  }

  const void* dynamicTypeToken() const override { return nativeTypeToken<SetObject<T>>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<SetObject<T>>() ? this : nullptr;
  }
  std::u16string dynamicToString() const override { return u"[object Set]"; }
  bool dynamicIsIterable() const override { return true; }
  std::size_t dynamicIterableSize() const override { return storage_->values.size(); }
  Value dynamicIterableGet(std::size_t index) override {
    if (index >= storage_->values.size()) return Value::undefined();
    return convertValue<Value>(storage_->values[index].load());
  }

  void Trace(cppgc::Visitor* visitor) const override {
    BaseObject::Trace(visitor);
    for (const auto& value : storage_->values) value.Trace(visitor);
  }

 private:
  void ensureUniqueStorage() {
    if (storage_.use_count() != 1) storage_ = std::make_shared<Storage>(*storage_);
  }
  std::shared_ptr<Storage> storage_ = std::make_shared<Storage>();
};

template <typename K, typename V>
class WeakMapObject final : public cppgc::GarbageCollected<WeakMapObject<K, V>>, public WeakMapLikeObject {
  static_assert(std::is_pointer_v<K>, "WeakMap keys must be managed object pointers");
  using KeyObject = std::remove_pointer_t<K>;

 public:
  WeakMapObject* set(K key, V value) {
    if (!key) throw runtimeError(u"Invalid WeakMap key");
    const auto existing = index_.find(key);
    if (existing != index_.end()) {
      entries_[existing->second]->value.store(std::move(value));
      return this;
    }
    index_.emplace(key, entries_.size());
    entries_.emplace_back(makeManaged<Entry>(key, std::move(value)));
    return this;
  }

  std::optional<V> get(K key) const {
    const auto found = index_.find(key);
    return found == index_.end()
        ? std::nullopt
        : std::optional<V>(entries_[found->second]->value.load());
  }

  bool has(K key) const { return get(key).has_value(); }
  bool erase(K key) {
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

  const void* dynamicTypeToken() const override { return nativeTypeToken<WeakMapObject<K, V>>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<WeakMapObject<K, V>>() ? this : nullptr;
  }
  std::u16string dynamicToString() const override { return u"[object WeakMap]"; }
  void Trace(cppgc::Visitor* visitor) const override {
    BaseObject::Trace(visitor);
    for (const auto& entry : entries_) visitor->Trace(entry);
    visitor->RegisterWeakCallbackMethod<
        WeakMapObject, &WeakMapObject::processWeakness>(this);
  }

 private:
  class Entry final : public cppgc::GarbageCollected<Entry> {
   public:
    Entry(K keyValue, V mappedValue) : key(keyValue), value(std::move(mappedValue)) {}
    void Trace(cppgc::Visitor* visitor) const {
      visitor->Trace(key);
      value.Trace(visitor);
    }
    cppgc::WeakMember<KeyObject> key;
    ArraySlot<V> value;
  };
  void processWeakness(const cppgc::LivenessBroker& broker) {
    entries_.erase(std::remove_if(entries_.begin(), entries_.end(), [](const auto& entry) {
      return entry->key.Get() == nullptr;
    }), entries_.end());
    entries_.erase(std::remove_if(entries_.begin(), entries_.end(), [&](const auto& entry) {
      return !broker.IsHeapObjectAlive(entry->key);
    }), entries_.end());
    index_.clear();
    for (std::size_t index = 0; index < entries_.size(); ++index) {
      index_.emplace(entries_[index]->key.Get(), index);
    }
  }
  std::vector<cppgc::Member<Entry>> entries_;
  std::unordered_map<K, std::size_t> index_;
};

template <typename T>
class WeakSetObject final : public cppgc::GarbageCollected<WeakSetObject<T>>, public WeakSetLikeObject {
  static_assert(std::is_pointer_v<T>, "WeakSet values must be managed object pointers");
  using ValueObject = std::remove_pointer_t<T>;

 public:
  WeakSetObject* add(T value) {
    if (!value) throw runtimeError(u"Invalid WeakSet value");
    if (index_.insert(value).second) values_.emplace_back(makeManaged<Entry>(value));
    return this;
  }
  bool has(T value) const {
    return index_.contains(value);
  }
  bool erase(T value) {
    if (index_.erase(value) == 0) return false;
    const auto found = std::find_if(values_.begin(), values_.end(), [&](const auto& candidate) {
      return candidate->value.Get() == value;
    });
    if (found == values_.end()) return true;
    values_.erase(found);
    return true;
  }
  const void* dynamicTypeToken() const override { return nativeTypeToken<WeakSetObject<T>>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<WeakSetObject<T>>() ? this : nullptr;
  }
  std::u16string dynamicToString() const override { return u"[object WeakSet]"; }
  void Trace(cppgc::Visitor* visitor) const override {
    BaseObject::Trace(visitor);
    for (const auto& value : values_) visitor->Trace(value);
    visitor->RegisterWeakCallbackMethod<
        WeakSetObject, &WeakSetObject::processWeakness>(this);
  }

 private:
  class Entry final : public cppgc::GarbageCollected<Entry> {
   public:
    explicit Entry(T entryValue) : value(entryValue) {}
    void Trace(cppgc::Visitor* visitor) const { visitor->Trace(value); }
    cppgc::WeakMember<ValueObject> value;
  };
  void processWeakness(const cppgc::LivenessBroker& broker) {
    values_.erase(std::remove_if(values_.begin(), values_.end(), [&](const auto& value) {
      return value->value.Get() == nullptr || !broker.IsHeapObjectAlive(value->value);
    }), values_.end());
    index_.clear();
    for (const auto& value : values_) index_.insert(value->value.Get());
  }
  std::vector<cppgc::Member<Entry>> values_;
  std::unordered_set<T> index_;
};

template <typename Kind>
inline bool isCollectionLikeValue(const Value& value) {
  return value.isRuntimeObject() && value.object()->dynamicCast(nativeTypeToken<Kind>()) != nullptr;
}

template <typename Kind, typename T>
inline bool isCollectionLikePointer(T* value) {
  return value && value->dynamicCast(nativeTypeToken<Kind>()) != nullptr;
}

inline bool isMapLike(const Value& value) { return isCollectionLikeValue<MapLikeObject>(value); }
inline bool isSetLike(const Value& value) { return isCollectionLikeValue<SetLikeObject>(value); }
inline bool isWeakMapLike(const Value& value) { return isCollectionLikeValue<WeakMapLikeObject>(value); }
inline bool isWeakSetLike(const Value& value) { return isCollectionLikeValue<WeakSetLikeObject>(value); }

template <typename T> inline bool isMapLike(T* value) { return isCollectionLikePointer<MapLikeObject>(value); }
template <typename T> inline bool isSetLike(T* value) { return isCollectionLikePointer<SetLikeObject>(value); }
template <typename T> inline bool isWeakMapLike(T* value) { return isCollectionLikePointer<WeakMapLikeObject>(value); }
template <typename T> inline bool isWeakSetLike(T* value) { return isCollectionLikePointer<WeakSetLikeObject>(value); }
