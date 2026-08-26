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

class MapObject final : public cppgc::GarbageCollected<MapObject>, public MapLikeObject {
 private:
  struct Entry final { StoredValue key; StoredValue value; };
  struct Storage final {
    std::vector<Entry> entries;
    std::unordered_map<Value, std::size_t, SameValueZeroHash<Value>, SameValueZeroEqual<Value>> index;
  };

 public:
  MapObject();
  explicit MapObject(MapLikeObject* dynamicBacking);
  explicit MapObject(const MapObject* source);
  static MapObject* fromDynamicObject(BaseObject* backing);
  bool usesDynamicBacking() const;
  std::size_t size() const;
  MapObject* set(Value key, Value value);
  std::optional<Value> get(const Value& key) const;
  bool has(const Value& key) const;
  bool erase(const Value& key);
  void clear();

  void forEach(const std::function<void(Value, Value, MapObject*)>& callback);

  const void* dynamicTypeToken() const override;
  void* dynamicCast(const void* type) override;
  std::u16string dynamicToString() const override;
  Value dynamicGet(const std::u16string& key) override;
  bool dynamicIsIterable() const override;
  std::size_t dynamicIterableSize() const override;
  Value dynamicIterableGet(std::size_t index) override;
  std::size_t dynamicMapSize() const override;
  Value dynamicMapKeyAt(std::size_t index) override;
  Value dynamicMapValueAt(std::size_t index) override;
  std::optional<Value> dynamicMapGet(const Value& key) override;
  void dynamicMapSet(const Value& key, const Value& value) override;
  bool dynamicMapDelete(const Value& key) override;
  void dynamicMapClear() override;
  void Trace(cppgc::Visitor* visitor) const override;

 private:
  void ensureUniqueStorage();
  void rebuildIndex();
  cppgc::Member<MapLikeObject> dynamic_backing_;
  std::shared_ptr<Storage> storage_;
};

class SetObject final : public cppgc::GarbageCollected<SetObject>, public SetLikeObject {
 private:
  struct Storage final {
    std::vector<StoredValue> values;
    std::unordered_set<Value, SameValueZeroHash<Value>, SameValueZeroEqual<Value>> index;
  };

 public:
  SetObject();
  explicit SetObject(const SetObject* source);
  std::size_t size() const;
  SetObject* add(Value value);
  bool has(const Value& value) const;
  bool erase(const Value& value);
  void clear();

  void forEach(const std::function<void(Value, Value, SetObject*)>& callback);

  const void* dynamicTypeToken() const override;
  void* dynamicCast(const void* type) override;
  std::u16string dynamicToString() const override;
  bool dynamicIsIterable() const override;
  std::size_t dynamicIterableSize() const override;
  Value dynamicIterableGet(std::size_t index) override;
  void Trace(cppgc::Visitor* visitor) const override;

 private:
  void ensureUniqueStorage();
  std::shared_ptr<Storage> storage_;
};

class WeakMapObject final : public cppgc::GarbageCollected<WeakMapObject>, public WeakMapLikeObject {
 public:
  WeakMapObject* set(BaseObject* key, Value value);
  std::optional<Value> get(BaseObject* key) const;
  bool has(BaseObject* key) const;
  bool erase(BaseObject* key);
  const void* dynamicTypeToken() const override;
  void* dynamicCast(const void* type) override;
  std::u16string dynamicToString() const override;
  void Trace(cppgc::Visitor* visitor) const override;

 private:
  class Entry final : public cppgc::GarbageCollected<Entry> {
   public:
    Entry(BaseObject* key, Value value);
    void Trace(cppgc::Visitor* visitor) const;
    cppgc::WeakMember<BaseObject> key;
    StoredValue value;
  };
  void processWeakness(const cppgc::LivenessBroker& broker);
  std::vector<cppgc::Member<Entry>> entries_;
  std::unordered_map<BaseObject*, std::size_t> index_;
};

class WeakSetObject final : public cppgc::GarbageCollected<WeakSetObject>, public WeakSetLikeObject {
 public:
  WeakSetObject* add(BaseObject* value);
  bool has(BaseObject* value) const;
  bool erase(BaseObject* value);
  const void* dynamicTypeToken() const override;
  void* dynamicCast(const void* type) override;
  std::u16string dynamicToString() const override;
  void Trace(cppgc::Visitor* visitor) const override;

 private:
  class Entry final : public cppgc::GarbageCollected<Entry> {
   public:
    explicit Entry(BaseObject* value);
    void Trace(cppgc::Visitor* visitor) const;
    cppgc::WeakMember<BaseObject> value;
  };
  void processWeakness(const cppgc::LivenessBroker& broker);
  std::vector<cppgc::Member<Entry>> values_;
  std::unordered_set<BaseObject*> index_;
};

bool isMapLike(const Value& value);
bool isSetLike(const Value& value);
bool isWeakMapLike(const Value& value);
bool isWeakSetLike(const Value& value);
bool isMapLike(BaseObject* value);
bool isSetLike(BaseObject* value);
bool isWeakMapLike(BaseObject* value);
bool isWeakSetLike(BaseObject* value);
