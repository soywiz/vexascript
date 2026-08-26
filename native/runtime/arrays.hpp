#pragma once

// Internal runtime category header. Include runtime.hpp instead.

template <typename T>
class ArraySlot final {
 public:
  ArraySlot() = default;
  explicit ArraySlot(T value) : value_(std::move(value)) {}

  T load() const { return value_; }
  const T& loadRef() const { return value_; }
  void store(T value) { value_ = std::move(value); }
  void Trace(cppgc::Visitor*) const {}

 private:
  T value_{};
};

// Generic native class fields are emitted as their template type so ordinary
// values retain value semantics. Pointer specializations still need to expose
// their Oilpan edge when the containing object is traced.
template <typename T>
inline void traceManagedValue(cppgc::Visitor*, const T&) {}

template <typename T>
inline void traceManagedValue(cppgc::Visitor* visitor, T* const& value) {
  if (!value) return;
  const cppgc::Member<T> member(value);
  visitor->Trace(member);
}

template <typename T>
class ArraySlot<T*> final {
 public:
  ArraySlot() = default;
  explicit ArraySlot(T* value) : value_(value) {}

  T* load() const { return value_; }
  T* const& loadRef() const { return value_; }
  void store(T* value) { value_ = value; }
  void Trace(cppgc::Visitor* visitor) const {
    const cppgc::Member<T> member(value_);
    visitor->Trace(member);
  }

 private:
  T* value_ = nullptr;
};

template <>
class ArraySlot<Value> final {
 public:
  ArraySlot() = default;
  explicit ArraySlot(Value value) : value_(value) {}

  Value load() const { return value_.load(); }
  void store(Value value) { value_.store(value); }
  void Trace(cppgc::Visitor* visitor) const { value_.Trace(visitor); }

 private:
  StoredValue value_;
};

template <typename T>
inline constexpr bool IsDynamicArrayElement =
    std::is_same_v<T, Value> || std::is_same_v<T, std::u16string> ||
    std::is_same_v<T, BigInt> || std::is_arithmetic_v<T> ||
    (std::is_pointer_v<T> &&
     (std::is_base_of_v<BaseObject, std::remove_pointer_t<T>> ||
      std::is_base_of_v<EnumerableObject, std::remove_pointer_t<T>> ||
      std::is_same_v<std::remove_pointer_t<T>, RecordObject>));

// Language arrays have reference semantics. The backing storage is an Oilpan
// object, and every GC-managed element is represented by a traced Member edge.
template <typename T>
class ArrayObject final : public cppgc::GarbageCollected<ArrayObject<T>>, public BaseObject {
 public:
  ArrayObject() = default;
  explicit ArrayObject(BaseObject* dynamicBacking) : dynamic_backing_(dynamicBacking) {}
  static ArrayObject* fromDynamicObject(BaseObject* backing);
  explicit ArrayObject(std::initializer_list<T> values) {
    values_.reserve(values.size());
    for (const auto& value : values) values_.emplace_back(value);
  }

  std::size_t size() const {
    return dynamic_backing_ ? dynamic_backing_->dynamicArraySize() : values_.size();
  }
  bool empty() const { return size() == 0; }
  void reserve(std::size_t capacity) {
    if (!dynamic_backing_) values_.reserve(capacity);
  }
  void resize(std::size_t size) {
    if (dynamic_backing_) {
      dynamic_backing_->dynamicSet(u"length", Value(static_cast<double>(size)));
      return;
    }
    values_.resize(size);
  }
  T get(std::size_t index) const {
    if (dynamic_backing_) {
      if (index >= size()) return T{};
      if constexpr (IsDynamicArrayElement<T>) {
        return convertValue<T>(dynamic_backing_->dynamicArrayGet(index));
      } else {
        throw runtimeError(u"This native array element type cannot flow through a dynamic array view");
      }
    }
    if (index >= values_.size()) return T{};
    return values_[index].load();
  }
  T set(std::size_t index, T value) {
    if (dynamic_backing_) {
      if constexpr (IsDynamicArrayElement<T>) {
        dynamic_backing_->dynamicSet(formatIntegerText(index), convertValue<Value>(value));
        return value;
      } else {
        throw runtimeError(u"This native array element type cannot flow through a dynamic array view");
      }
    }
    if (index >= values_.size()) values_.resize(index + 1);
    values_[index].store(value);
    return value;
  }
  void append(T value) {
    if (dynamic_backing_) {
      set(size(), value);
      return;
    }
    values_.emplace_back(std::move(value));
  }
  void insert(std::size_t index, T value) {
    values_.insert(
        values_.begin() + static_cast<std::ptrdiff_t>(std::min(index, values_.size())),
        ArraySlot<T>(std::move(value)));
  }
  void prepend(T value) { values_.insert(values_.begin(), ArraySlot<T>(std::move(value))); }
  double push(T value) {
    append(std::move(value));
    return static_cast<double>(size());
  }
  T removeLast() {
    if (values_.empty()) return T{};
    T value = values_.back().load();
    values_.pop_back();
    return value;
  }
  T removeFirst() {
    if (values_.empty()) return T{};
    T value = values_.front().load();
    values_.erase(values_.begin());
    return value;
  }
  T pop() { return removeLast(); }
  T shift() { return removeFirst(); }
  double unshift(T value) {
    prepend(std::move(value));
    return static_cast<double>(size());
  }
  ArrayObject* reverse() {
    std::reverse(values_.begin(), values_.end());
    return this;
  }

  template <typename U>
  bool includes(const U& value) const;
  template <typename U>
  double indexOf(const U& value) const;
  template <typename U>
  double lastIndexOf(const U& value) const;
  T at(double index) const;
  ArrayObject* slice(
      double start = 0,
      double end = std::numeric_limits<double>::infinity()) const;
  template <typename... Items>
  ArrayObject* concat(Items&&... items) const;
  template <typename Callback>
  auto map(Callback callback) const;
  template <typename Callback>
  ArrayObject* filter(Callback callback) const;
  template <typename Callback, typename Accumulator>
  Accumulator reduce(Callback callback, Accumulator initial) const;
  template <typename Callback, typename Accumulator>
  Accumulator reduceRight(Callback callback, Accumulator initial) const;
  template <typename Callback>
  void forEach(Callback callback) const;
  template <typename Callback>
  bool some(Callback callback) const;
  template <typename Callback>
  bool every(Callback callback) const;
  template <typename Callback>
  double findIndex(Callback callback) const;
  template <typename Callback>
  T find(Callback callback) const;
  template <typename Callback>
  double findLastIndex(Callback callback) const;
  template <typename Callback>
  T findLast(Callback callback) const;
  ArrayObject* toReversed() const;
  ArrayObject* take(double limit) const;
  ArrayObject* drop(double count) const;
  ArrayObject* toArray() const;
  ArrayObject* values() const;
  ArrayObject<double>* keys() const;
  ArrayObject<ArrayObject<Value>*>* entries() const;
  ArrayObject* toSorted() const;
  template <typename Callback>
  ArrayObject* toSorted(Callback callback) const;
  template <typename... Items>
  ArrayObject* toSpliced(
      double start,
      double deleteCount = std::numeric_limits<double>::infinity(),
      Items&&... items) const;
  ArrayObject* with(double index, T value) const;
  template <typename... Items>
  ArrayObject* splice(
      double start,
      double deleteCount = std::numeric_limits<double>::infinity(),
      Items&&... items);
  ArrayObject* fill(T value, double start = 0, double end = std::numeric_limits<double>::infinity());
  ArrayObject* copyWithin(double target, double start, double end = std::numeric_limits<double>::infinity());
  ArrayObject* sort();
  template <typename Callback>
  ArrayObject* sort(Callback callback);
  std::u16string join(const std::u16string& separator = u",") const;
  std::u16string toString() const;
  std::u16string toLocaleString() const { return toString(); }
  const void* dynamicTypeToken() const override { return nativeTypeToken<ArrayObject<T>>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<ArrayObject<T>>() ? this : nullptr;
  }
  std::u16string dynamicToString() const override { return toString(); }
  bool dynamicIsArray() const override { return true; }
  bool dynamicIsIterable() const override { return true; }
  std::size_t dynamicIterableSize() const override { return size(); }
  Value dynamicIterableGet(std::size_t index) override {
    return dynamicArrayGet(index);
  }
  std::size_t dynamicArraySize() const override { return size(); }
  Value dynamicArrayGet(std::size_t index) override {
    if constexpr (IsDynamicArrayElement<T>) {
      return index < size() ? convertValue<Value>(get(index)) : Value::undefined();
    } else {
      throw runtimeError(u"This native array element type cannot flow through dynamic iteration");
    }
  }
  std::optional<std::u16string> dynamicJsonStringify(std::unordered_set<const void*>& seen) const override {
    if (!seen.insert(this).second) throw runtimeError(u"Converting circular structure to JSON");
    std::u16string output = u"[";
    for (std::size_t index = 0; index < size(); ++index) {
      if (index > 0) output += u',';
      output += jsonStringifyNative(get(index), seen);
    }
    output += u']';
    seen.erase(this);
    return output;
  }
  Value dynamicGet(const std::u16string& key) override;
  Value dynamicSet(const std::u16string& key, const Value& value) override {
        if constexpr (IsDynamicArrayElement<T>) {
      if (key == u"length") {
        resize(static_cast<std::size_t>(convertValue<double>(value)));
        return value;
      }
      const auto index = propertyIndex(key);
      if (!index) throw runtimeError(u"Invalid dynamic array index");
      set(*index, convertValue<T>(value));
      return value;
    } else {
      throw runtimeError(u"This native array element type cannot flow through dynamic access");
    }
  }
  bool dynamicDelete(const std::u16string&) override { return false; }

  class Iterator final {
   public:
    Iterator(const ArrayObject* array, std::size_t index) : array_(array), index_(index) {}
    T operator*() const { return array_->get(index_); }
    Iterator& operator++() { ++index_; return *this; }
    bool operator!=(const Iterator& other) const { return index_ != other.index_; }

   private:
    const ArrayObject* array_;
    std::size_t index_;
  };

  Iterator begin() const { return Iterator(this, 0); }
  Iterator end() const { return Iterator(this, size()); }

  void Trace(cppgc::Visitor* visitor) const override {
    BaseObject::Trace(visitor);
    visitor->Trace(dynamic_backing_);
    for (const auto& value : values_) value.Trace(visitor);
  }

 private:
  cppgc::Member<BaseObject> dynamic_backing_;
  std::vector<ArraySlot<T>> values_;
};
