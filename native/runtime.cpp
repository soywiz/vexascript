// Minimal VexaScript C++ runtime. This file is intentionally both a header and
// an implementation so generated translation units can include one runtime file.
#pragma once

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cmath>
#include <coroutine>
#include <cstdlib>
#include <cstdint>
#include <deque>
#include <exception>
#include <functional>
#include <iomanip>
#include <initializer_list>
#include <iostream>
#include <iterator>
#include <limits>
#include <memory>
#include <optional>
#include <queue>
#include <regex>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <stdexcept>
#include <type_traits>
#include <unordered_map>
#include <utility>
#include <variant>
#include <vector>

#include <cppgc/allocation.h>
#include <cppgc/garbage-collected.h>
#include <cppgc/heap.h>
#include <cppgc/member.h>
#include <cppgc/persistent.h>
#include <cppgc/platform.h>
#include <cppgc/visitor.h>
#include <src/base/page-allocator.h>

namespace vexa {

class OilpanPlatform final : public cppgc::Platform {
 public:
  cppgc::PageAllocator* GetPageAllocator() override { return &allocator_; }

  double MonotonicallyIncreasingTime() override {
    using Seconds = std::chrono::duration<double>;
    return Seconds(std::chrono::steady_clock::now().time_since_epoch()).count();
  }

 private:
  v8::base::PageAllocator allocator_;
};

class StringObject final : public cppgc::GarbageCollected<StringObject> {
 public:
  explicit StringObject(std::string value) : value_(std::move(value)) {}

  void Trace(cppgc::Visitor*) const {}
  const std::string& value() const { return value_; }

 private:
  std::string value_;
};

struct Undefined final {};
struct Null final {};
class RecordObject;
class Runtime;

class Value final {
 public:
  using Storage = std::variant<
      Undefined,
      Null,
      bool,
      double,
      cppgc::Persistent<StringObject>,
      cppgc::Persistent<RecordObject>>;

  Value() : storage_(Undefined{}) {}
  Value(bool value) : storage_(value) {}
  Value(double value) : storage_(value) {}
  Value(int value) : storage_(static_cast<double>(value)) {}
  explicit Value(StringObject* value) : storage_(cppgc::Persistent<StringObject>(value)) {}
  explicit Value(RecordObject* value);

  static Value undefined() { return Value(); }
  static Value null() { return Value(Null{}); }

  bool isUndefined() const { return std::holds_alternative<Undefined>(storage_); }
  bool isNull() const { return std::holds_alternative<Null>(storage_); }
  bool isBoolean() const { return std::holds_alternative<bool>(storage_); }
  bool isNumber() const { return std::holds_alternative<double>(storage_); }
  bool isString() const { return std::holds_alternative<cppgc::Persistent<StringObject>>(storage_); }
  bool isRecord() const { return std::holds_alternative<cppgc::Persistent<RecordObject>>(storage_); }

  bool boolean() const { return std::get<bool>(storage_); }
  double number() const { return std::get<double>(storage_); }
  const std::string& string() const {
    return std::get<cppgc::Persistent<StringObject>>(storage_)->value();
  }
  RecordObject* record() const;

  bool operator==(const Value& other) const;

 private:
  friend class StoredValue;
  explicit Value(Null value) : storage_(value) {}
  Storage storage_;
};

class StoredValue final {
 public:
  using Storage = std::variant<
      Undefined,
      Null,
      bool,
      double,
      cppgc::Member<StringObject>,
      cppgc::Member<RecordObject>>;

  StoredValue() : storage_(Undefined{}) {}
  explicit StoredValue(const Value& value) { store(value); }

  Value load() const;
  void store(const Value& value);
  void Trace(cppgc::Visitor* visitor) const;

 private:
  Storage storage_;
};

class RecordObject final : public cppgc::GarbageCollected<RecordObject> {
 public:
  Value get(const std::string& key) const {
    const auto property = properties_.find(key);
    return property == properties_.end() ? Value::undefined() : property->second.load();
  }

  void set(std::string key, const Value& value) {
    properties_.insert_or_assign(std::move(key), StoredValue(value));
  }

  bool has(const std::string& key) const { return properties_.contains(key); }
  bool erase(const std::string& key) { return properties_.erase(key) > 0; }

  void copyTo(RecordObject* target) const {
    for (const auto& [key, value] : properties_) target->set(key, value.load());
  }

  std::vector<std::string> keys() const {
    std::vector<std::string> result;
    result.reserve(properties_.size());
    for (const auto& [key, value] : properties_) result.push_back(key);
    return result;
  }

  std::vector<Value> values() const {
    std::vector<Value> result;
    result.reserve(properties_.size());
    for (const auto& [key, value] : properties_) result.push_back(value.load());
    return result;
  }

  void Trace(cppgc::Visitor* visitor) const {
    for (const auto& [key, value] : properties_) value.Trace(visitor);
  }

 private:
  std::unordered_map<std::string, StoredValue> properties_;
};

inline Value::Value(RecordObject* value)
    : storage_(cppgc::Persistent<RecordObject>(value)) {}

inline RecordObject* Value::record() const {
  return std::get<cppgc::Persistent<RecordObject>>(storage_).Get();
}

inline bool Value::operator==(const Value& other) const {
  if (storage_.index() != other.storage_.index()) return false;
  if (isUndefined() || isNull()) return true;
  if (isBoolean()) return boolean() == other.boolean();
  if (isNumber()) return number() == other.number();
  if (isString()) return string() == other.string();
  return record() == other.record();
}

inline Value StoredValue::load() const {
  if (std::holds_alternative<Undefined>(storage_)) return Value::undefined();
  if (std::holds_alternative<Null>(storage_)) return Value::null();
  if (const auto* value = std::get_if<bool>(&storage_)) return Value(*value);
  if (const auto* value = std::get_if<double>(&storage_)) return Value(*value);
  if (const auto* value = std::get_if<cppgc::Member<StringObject>>(&storage_)) {
    return Value(value->Get());
  }
  return Value(std::get<cppgc::Member<RecordObject>>(storage_).Get());
}

inline void StoredValue::store(const Value& value) {
  if (value.isUndefined()) storage_ = Undefined{};
  else if (value.isNull()) storage_ = Null{};
  else if (value.isBoolean()) storage_ = value.boolean();
  else if (value.isNumber()) storage_ = value.number();
  else if (value.isString()) {
    storage_ = cppgc::Member<StringObject>(
        std::get<cppgc::Persistent<StringObject>>(value.storage_).Get());
  } else {
    storage_ = cppgc::Member<RecordObject>(value.record());
  }
}

inline void StoredValue::Trace(cppgc::Visitor* visitor) const {
  if (const auto* value = std::get_if<cppgc::Member<StringObject>>(&storage_)) {
    visitor->Trace(*value);
  } else if (const auto* value = std::get_if<cppgc::Member<RecordObject>>(&storage_)) {
    visitor->Trace(*value);
  }
}

template <typename T>
class ArraySlot final {
 public:
  ArraySlot() = default;
  explicit ArraySlot(T value) : value_(std::move(value)) {}

  T load() const { return value_; }
  void store(T value) { value_ = std::move(value); }
  void Trace(cppgc::Visitor*) const {}

 private:
  T value_{};
};

template <typename T>
class ArraySlot<T*> final {
 public:
  ArraySlot() = default;
  explicit ArraySlot(T* value) : value_(value) {}

  T* load() const { return value_.Get(); }
  void store(T* value) { value_ = value; }
  void Trace(cppgc::Visitor* visitor) const { visitor->Trace(value_); }

 private:
  cppgc::Member<T> value_;
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

// Language arrays have reference semantics. The backing storage is an Oilpan
// object, and every GC-managed element is represented by a traced Member edge.
template <typename T>
class ArrayObject final : public cppgc::GarbageCollected<ArrayObject<T>> {
 public:
  ArrayObject() = default;
  explicit ArrayObject(std::initializer_list<T> values) {
    values_.reserve(values.size());
    for (const auto& value : values) values_.emplace_back(value);
  }

  std::size_t size() const { return values_.size(); }
  bool empty() const { return values_.empty(); }
  T get(std::size_t index) const {
    if (index >= values_.size()) throw std::out_of_range("VexaScript array index is out of range");
    return values_[index].load();
  }
  T set(std::size_t index, T value) {
    if (index >= values_.size()) values_.resize(index + 1);
    values_[index].store(value);
    return value;
  }
  void append(T value) { values_.emplace_back(value); }
  void prepend(T value) { values_.insert(values_.begin(), ArraySlot<T>(value)); }
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
  ArrayObject* slice(
      Runtime& runtime,
      double start = 0,
      double end = std::numeric_limits<double>::infinity()) const;
  template <typename... Items>
  ArrayObject* concat(Runtime& runtime, Items&&... items) const;
  template <typename Callback>
  auto map(Runtime& runtime, Callback callback) const
      -> ArrayObject<std::remove_cvref_t<std::invoke_result_t<Callback, T>>>*;
  template <typename Callback>
  ArrayObject* filter(Runtime& runtime, Callback callback) const;
  template <typename Callback, typename Accumulator>
  Accumulator reduce(Callback callback, Accumulator initial) const;
  std::string join(const std::string& separator = ",") const;
  std::string toString() const;

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

  void Trace(cppgc::Visitor* visitor) const {
    for (const auto& value : values_) value.Trace(visitor);
  }

 private:
  std::vector<ArraySlot<T>> values_;
};

template <typename T>
inline ArrayObject<T>* arrayPointer(ArrayObject<T>* array) {
  return array;
}

template <typename T>
inline ArrayObject<T>* arrayPointer(const cppgc::Member<ArrayObject<T>>& array) {
  return array.Get();
}

template <typename T>
inline ArrayObject<T>* arrayPointer(const cppgc::Persistent<ArrayObject<T>>& array) {
  return array.Get();
}

class Error final {
 public:
  explicit Error(const Value& value)
      : message_(value.isString() ? value.string() : "Error") {}
  explicit Error(std::string message) : message_(std::move(message)) {}

  const std::string& message() const { return message_; }

 private:
  std::string message_;
};

class RegExp final {
 public:
  RegExp(std::string pattern, const std::string& flags)
      : expression_(std::move(pattern), flags.find('i') != std::string::npos
          ? std::regex_constants::ECMAScript | std::regex_constants::icase
          : std::regex_constants::ECMAScript) {}

  bool test(const std::string& value) const { return std::regex_search(value, expression_); }

 private:
  std::regex expression_;
};

inline bool regexTest(const RegExp& expression, const std::string& value) {
  return expression.test(value);
}

inline bool regexTest(const RegExp& expression, const Value& value) {
  return expression.test(value.isString() ? value.string() : "");
}

template <typename Callback>
class Finally final {
 public:
  explicit Finally(Callback callback) : callback_(std::move(callback)) {}
  Finally(const Finally&) = delete;
  Finally& operator=(const Finally&) = delete;

  Finally(Finally&& other) noexcept
      : callback_(std::move(other.callback_)), active_(std::exchange(other.active_, false)) {}

  ~Finally() noexcept(false) {
    if (active_) callback_();
  }

 private:
  Callback callback_;
  bool active_ = true;
};

template <typename Callback>
Finally<std::decay_t<Callback>> finally(Callback&& callback) {
  return Finally<std::decay_t<Callback>>(std::forward<Callback>(callback));
}

class Runtime final {
 public:
  using TimerId = std::int32_t;
  using TimerCallback = std::function<void()>;

  Runtime() : platform_(std::make_shared<OilpanPlatform>()) {
    cppgc::InitializeProcess(platform_->GetPageAllocator());
    cppgc::Heap::HeapOptions options;
    options.marking_support = cppgc::Heap::MarkingType::kAtomic;
    options.sweeping_support = cppgc::Heap::SweepingType::kAtomic;
    options.stack_support = cppgc::Heap::StackSupport::kSupportsConservativeStackScan;
    options.stack_start_marker.emplace();
    heap_ = cppgc::Heap::Create(platform_, std::move(options));
  }

  Runtime(const Runtime&) = delete;
  Runtime& operator=(const Runtime&) = delete;

  ~Runtime() {
    heap_.reset();
    cppgc::ShutdownProcess();
  }

  Value string(std::string value) {
    return Value(cppgc::MakeGarbageCollected<StringObject>(
        heap_->GetAllocationHandle(), std::move(value)));
  }

  RecordObject* record(
      std::initializer_list<std::pair<std::string, Value>> properties = {}) {
    auto* result = make<RecordObject>();
    for (const auto& [key, value] : properties) result->set(key, value);
    return result;
  }

  template <typename T>
  ArrayObject<T>* array(std::initializer_list<T> values = {}) {
    return make<ArrayObject<T>>(values);
  }

  template <typename T, typename... Arguments>
  T* make(Arguments&&... arguments) {
    return cppgc::MakeGarbageCollected<T>(
        heap_->GetAllocationHandle(), std::forward<Arguments>(arguments)...);
  }

  cppgc::Heap& heap() { return *heap_; }

  TimerId setTimeout(TimerCallback callback, double delay = 0) {
    return scheduleTimer(std::move(callback), delay, false);
  }

  TimerId setInterval(TimerCallback callback, double delay = 0) {
    return scheduleTimer(std::move(callback), delay, true);
  }

  void clearTimeout(TimerId id) { timers_.erase(id); }
  void clearInterval(TimerId id) { timers_.erase(id); }

  void runEventLoop() {
    while (runOneEvent()) {}
  }

  void enqueueMicrotask(TimerCallback callback) {
    microtasks_.push_back(std::move(callback));
  }

  template <typename Predicate>
  void runUntil(Predicate settled) {
    while (!settled()) {
      if (!runOneEvent()) {
        throw std::runtime_error("VexaScript task cannot settle because the event loop is empty");
      }
    }
  }

 private:
  using Clock = std::chrono::steady_clock;

  struct TimerState final {
    TimerCallback callback;
    double delay;
    bool repeating;
  };

  struct ScheduledTimer final {
    Clock::time_point due;
    TimerId id;
  };

  struct EarlierTimer final {
    bool operator()(const ScheduledTimer& left, const ScheduledTimer& right) const {
      if (left.due != right.due) return left.due > right.due;
      return left.id > right.id;
    }
  };

  static Clock::time_point deadline(double delay) {
    const auto milliseconds = std::chrono::duration<double, std::milli>(std::max(0.0, delay));
    return Clock::now() + std::chrono::duration_cast<Clock::duration>(milliseconds);
  }

  TimerId scheduleTimer(TimerCallback callback, double delay, bool repeating) {
    const TimerId id = nextTimerId_++;
    timers_.emplace(id, TimerState{std::move(callback), delay, repeating});
    scheduledTimers_.push({deadline(delay), id});
    return id;
  }

  bool runOneEvent() {
    if (!microtasks_.empty()) {
      TimerCallback callback = std::move(microtasks_.front());
      microtasks_.pop_front();
      callback();
      return true;
    }

    while (!scheduledTimers_.empty()) {
      const ScheduledTimer scheduled = scheduledTimers_.top();
      scheduledTimers_.pop();
      auto timer = timers_.find(scheduled.id);
      if (timer == timers_.end()) continue;

      const auto now = Clock::now();
      if (scheduled.due > now) std::this_thread::sleep_until(scheduled.due);

      TimerCallback callback = timer->second.callback;
      const bool repeating = timer->second.repeating;
      if (!repeating) timers_.erase(timer);
      callback();

      timer = timers_.find(scheduled.id);
      if (repeating && timer != timers_.end()) {
        scheduledTimers_.push({deadline(timer->second.delay), scheduled.id});
      }
      return true;
    }
    return false;
  }

  std::shared_ptr<OilpanPlatform> platform_;
  std::unique_ptr<cppgc::Heap> heap_;
  TimerId nextTimerId_ = 1;
  std::deque<TimerCallback> microtasks_;
  std::unordered_map<TimerId, TimerState> timers_;
  std::priority_queue<ScheduledTimer, std::vector<ScheduledTimer>, EarlierTimer> scheduledTimers_;
};

template <typename Result, typename Input>
Result convertValue(Runtime& runtime, Input&& input) {
  using Source = std::remove_cvref_t<Input>;
  if constexpr (std::is_same_v<Result, Value>) {
    if constexpr (std::is_same_v<Source, Value>) {
      return std::forward<Input>(input);
    } else if constexpr (std::is_same_v<Source, std::string>) {
      return runtime.string(std::forward<Input>(input));
    } else {
      return Value(std::forward<Input>(input));
    }
  } else if constexpr (std::is_same_v<Source, Value>) {
    if constexpr (std::is_same_v<Result, bool>) {
      if (input.isBoolean()) return input.boolean();
      if (input.isNumber()) return input.number() != 0 && !std::isnan(input.number());
      return !input.isUndefined() && !input.isNull();
    } else if constexpr (std::is_arithmetic_v<Result>) {
      if (input.isNumber()) return static_cast<Result>(input.number());
      if (input.isBoolean()) return static_cast<Result>(input.boolean());
      throw std::runtime_error("VexaScript value is not numeric");
    } else if constexpr (std::is_same_v<Result, RecordObject*>) {
      if (!input.isRecord()) throw std::runtime_error("VexaScript value is not an object");
      return input.record();
    } else {
      return std::forward<Input>(input);
    }
  } else {
    return std::forward<Input>(input);
  }
}

template <typename Result>
Result recordGet(Runtime& runtime, RecordObject* record, const std::string& key) {
  if (!record) throw std::runtime_error("Cannot read a property of null");
  return convertValue<Result>(runtime, record->get(key));
}

template <typename Input>
std::remove_cvref_t<Input> recordSet(
    Runtime& runtime,
    RecordObject* record,
    const std::string& key,
    Input&& input) {
  if (!record) throw std::runtime_error("Cannot write a property of null");
  using Result = std::remove_cvref_t<Input>;
  Result result = std::forward<Input>(input);
  record->set(key, convertValue<Value>(runtime, result));
  return result;
}

inline const std::string& propertyKey(const std::string& value) { return value; }
inline std::string propertyKey(double value) {
  std::ostringstream output;
  output << std::setprecision(15) << value;
  return output.str();
}
inline std::string propertyKey(std::int32_t value) { return std::to_string(value); }
inline std::string propertyKey(std::int64_t value) { return std::to_string(value); }
inline std::string propertyKey(bool value) { return value ? "true" : "false"; }
inline std::string propertyKey(const Value& value) {
  if (value.isString()) return value.string();
  if (value.isNumber()) return propertyKey(value.number());
  if (value.isBoolean()) return propertyKey(value.boolean());
  if (value.isNull()) return "null";
  if (value.isUndefined()) return "undefined";
  return "[object Object]";
}

inline RecordObject* recordSpread(RecordObject* target, RecordObject* source) {
  if (!target || !source) throw std::runtime_error("Cannot spread a null object");
  source->copyTo(target);
  return target;
}

inline bool recordHas(RecordObject* record, const std::string& key) {
  return record && record->has(key);
}

inline bool recordDelete(RecordObject* record, const std::string& key) {
  return record && record->erase(key);
}

inline Value recordGetOptional(RecordObject* record, const std::string& key) {
  return record ? record->get(key) : Value::undefined();
}

inline ArrayObject<std::string>* recordKeys(Runtime& runtime, RecordObject* record) {
  auto* result = runtime.array<std::string>();
  if (record) for (const auto& key : record->keys()) result->append(key);
  return result;
}

inline ArrayObject<Value>* recordValues(Runtime& runtime, RecordObject* record) {
  auto* result = runtime.array<Value>();
  if (record) for (const auto& value : record->values()) result->append(value);
  return result;
}

template <typename Callback>
Value nullishCoalesce(Value value, Callback&& fallback) {
  return value.isNull() || value.isUndefined()
      ? std::forward<Callback>(fallback)()
      : value;
}

template <typename T, typename Callback>
T* nullishCoalesce(T* value, Callback&& fallback) {
  return value ? value : std::forward<Callback>(fallback)();
}

template <typename T>
std::vector<T> range(T start, T end, bool exclusive) {
  std::vector<T> values;
  for (T current = start; exclusive ? current < end : current <= end; ++current) {
    values.push_back(current);
  }
  return values;
}

template <typename T>
struct TaskStorage final {
  using Type = T;

  static Type store(T value) { return std::move(value); }
  static T load(const Type& value) { return value; }
};

template <typename T>
struct TaskStorage<T*> final {
  using Type = cppgc::Persistent<T>;

  static Type store(T* value) { return Type(value); }
  static T* load(const Type& value) { return value.Get(); }
};

template <typename T>
class ReturnSignal final {
 public:
  explicit ReturnSignal(T value) : value_(TaskStorage<T>::store(std::move(value))) {}
  T value() const { return TaskStorage<T>::load(value_); }

 private:
  typename TaskStorage<T>::Type value_;
};

template <>
class ReturnSignal<void> final {};

class BreakSignal final {};
class ContinueSignal final {};

template <typename T>
class Task final {
 public:
  struct State final {
    Runtime* runtime = nullptr;
    std::optional<typename TaskStorage<T>::Type> value;
    std::exception_ptr error;
    std::vector<std::function<void()>> continuations;
    bool settled = false;
  };

  struct promise_type final {
    template <typename... Arguments>
    explicit promise_type(Runtime& runtime, Arguments&&...) : state(makeState(runtime)) {}

    template <typename Owner, typename... Arguments>
    promise_type(Owner&, Runtime& runtime, Arguments&&...) : state(makeState(runtime)) {}

    Task get_return_object() { return Task(state); }
    std::suspend_never initial_suspend() const noexcept { return {}; }
    std::suspend_never final_suspend() const noexcept { return {}; }
    void return_value(T value) { resolve(state, std::move(value)); }
    void unhandled_exception() { reject(state, std::current_exception()); }

    std::shared_ptr<State> state;
  };

  class Awaiter final {
   public:
    explicit Awaiter(std::shared_ptr<State> state) : state_(std::move(state)) {}
    bool await_ready() const noexcept { return state_->settled; }
    void await_suspend(std::coroutine_handle<> continuation) {
      onSettled(state_, [continuation]() mutable { continuation.resume(); });
    }
    T await_resume() const {
      if (state_->error) std::rethrow_exception(state_->error);
      return TaskStorage<T>::load(*state_->value);
    }

   private:
    std::shared_ptr<State> state_;
  };

  template <typename Executor>
  static Task create(Runtime& runtime, Executor executor) {
    auto state = makeState(runtime);
    try {
      executor(Resolver(state), Rejecter(state));
    } catch (...) {
      reject(state, std::current_exception());
    }
    return Task(std::move(state));
  }

  template <typename Work>
  static Task schedule(Runtime& runtime, Work work) {
    auto state = makeState(runtime);
    runtime.enqueueMicrotask([state, work = std::move(work)]() mutable {
      try {
        resolve(state, work());
      } catch (...) {
        reject(state, std::current_exception());
      }
    });
    return Task(std::move(state));
  }

  T get() const {
    state_->runtime->runUntil([this] { return state_->settled; });
    if (state_->error) std::rethrow_exception(state_->error);
    return TaskStorage<T>::load(*state_->value);
  }

  Awaiter operator co_await() const { return Awaiter(state_); }

 private:
  class Resolver final {
   public:
    explicit Resolver(std::shared_ptr<State> state) : state_(std::move(state)) {}

    void operator()() const {
      if constexpr (std::is_same_v<T, Value>) {
        resolve(state_, Value::undefined());
      } else {
        resolve(state_, T{});
      }
    }

    void operator()(T value) const { resolve(state_, std::move(value)); }

   private:
    std::shared_ptr<State> state_;
  };

  class Rejecter final {
   public:
    explicit Rejecter(std::shared_ptr<State> state) : state_(std::move(state)) {}

    void operator()() const {
      reject(state_, std::make_exception_ptr(std::runtime_error("Promise rejected")));
    }

    void operator()(const Error& error) const {
      reject(state_, std::make_exception_ptr(std::runtime_error(error.message())));
    }

    template <typename Reason>
    void operator()(const Reason&) const {
      reject(state_, std::make_exception_ptr(std::runtime_error("Promise rejected")));
    }

   private:
    std::shared_ptr<State> state_;
  };

  static std::shared_ptr<State> makeState(Runtime& runtime) {
    auto state = std::make_shared<State>();
    state->runtime = &runtime;
    return state;
  }

  static void resolve(const std::shared_ptr<State>& state, T value) {
    if (state->settled) return;
    state->value.emplace(TaskStorage<T>::store(std::move(value)));
    state->settled = true;
    notify(state);
  }

  static void reject(const std::shared_ptr<State>& state, std::exception_ptr error) {
    if (state->settled) return;
    state->error = std::move(error);
    state->settled = true;
    notify(state);
  }

  static void onSettled(const std::shared_ptr<State>& state, std::function<void()> continuation) {
    if (state->settled) state->runtime->enqueueMicrotask(std::move(continuation));
    else state->continuations.push_back(std::move(continuation));
  }

  static void notify(const std::shared_ptr<State>& state) {
    for (auto& continuation : state->continuations) {
      state->runtime->enqueueMicrotask(std::move(continuation));
    }
    state->continuations.clear();
  }

  explicit Task(std::shared_ptr<State> state) : state_(std::move(state)) {}

  std::shared_ptr<State> state_;
};

template <>
class Task<void> final {
 public:
  struct State final {
    Runtime* runtime = nullptr;
    std::exception_ptr error;
    std::vector<std::function<void()>> continuations;
    bool settled = false;
  };

  struct promise_type final {
    template <typename... Arguments>
    explicit promise_type(Runtime& runtime, Arguments&&...) : state(makeState(runtime)) {}

    template <typename Owner, typename... Arguments>
    promise_type(Owner&, Runtime& runtime, Arguments&&...) : state(makeState(runtime)) {}

    Task get_return_object() { return Task(state); }
    std::suspend_never initial_suspend() const noexcept { return {}; }
    std::suspend_never final_suspend() const noexcept { return {}; }
    void return_void() { resolve(state); }
    void unhandled_exception() { reject(state, std::current_exception()); }

    std::shared_ptr<State> state;
  };

  class Awaiter final {
   public:
    explicit Awaiter(std::shared_ptr<State> state) : state_(std::move(state)) {}
    bool await_ready() const noexcept { return state_->settled; }
    void await_suspend(std::coroutine_handle<> continuation) {
      onSettled(state_, [continuation]() mutable { continuation.resume(); });
    }
    void await_resume() const {
      if (state_->error) std::rethrow_exception(state_->error);
    }

   private:
    std::shared_ptr<State> state_;
  };

  template <typename Executor>
  static Task create(Runtime& runtime, Executor executor) {
    auto state = makeState(runtime);
    try {
      executor(Resolver(state), Rejecter(state));
    } catch (...) {
      reject(state, std::current_exception());
    }
    return Task(std::move(state));
  }

  template <typename Work>
  static Task schedule(Runtime& runtime, Work work) {
    auto state = makeState(runtime);
    runtime.enqueueMicrotask([state, work = std::move(work)]() mutable {
      try {
        work();
        resolve(state);
      } catch (...) {
        reject(state, std::current_exception());
      }
    });
    return Task(std::move(state));
  }

  void get() const {
    state_->runtime->runUntil([this] { return state_->settled; });
    if (state_->error) std::rethrow_exception(state_->error);
  }

  Awaiter operator co_await() const { return Awaiter(state_); }

 private:
  class Resolver final {
   public:
    explicit Resolver(std::shared_ptr<State> state) : state_(std::move(state)) {}
    void operator()() const { resolve(state_); }

   private:
    std::shared_ptr<State> state_;
  };

  class Rejecter final {
   public:
    explicit Rejecter(std::shared_ptr<State> state) : state_(std::move(state)) {}

    void operator()() const {
      reject(state_, std::make_exception_ptr(std::runtime_error("Promise rejected")));
    }

    void operator()(const Error& error) const {
      reject(state_, std::make_exception_ptr(std::runtime_error(error.message())));
    }

    template <typename Reason>
    void operator()(const Reason&) const {
      reject(state_, std::make_exception_ptr(std::runtime_error("Promise rejected")));
    }

   private:
    std::shared_ptr<State> state_;
  };

  static std::shared_ptr<State> makeState(Runtime& runtime) {
    auto state = std::make_shared<State>();
    state->runtime = &runtime;
    return state;
  }

  static void resolve(const std::shared_ptr<State>& state) {
    if (state->settled) return;
    state->settled = true;
    notify(state);
  }

  static void reject(const std::shared_ptr<State>& state, std::exception_ptr error) {
    if (state->settled) return;
    state->error = std::move(error);
    state->settled = true;
    notify(state);
  }

  static void onSettled(const std::shared_ptr<State>& state, std::function<void()> continuation) {
    if (state->settled) state->runtime->enqueueMicrotask(std::move(continuation));
    else state->continuations.push_back(std::move(continuation));
  }

  static void notify(const std::shared_ptr<State>& state) {
    for (auto& continuation : state->continuations) {
      state->runtime->enqueueMicrotask(std::move(continuation));
    }
    state->continuations.clear();
  }

  explicit Task(std::shared_ptr<State> state) : state_(std::move(state)) {}

  std::shared_ptr<State> state_;
};

template <typename T>
inline T defaultValue() {
  return T{};
}

template <>
inline Value defaultValue<Value>() {
  return Value::undefined();
}

template <typename T>
class Ready final {
 public:
  explicit Ready(T value) : value_(std::move(value)) {}
  T get() const { return value_; }

 private:
  T value_;
};

template <typename T>
struct GeneratorResult final {
  bool done;
  T value;
};

template <typename T, bool Async>
class BasicGenerator final {
 public:
  struct promise_type final {
    class YieldAwaiter final {
     public:
      explicit YieldAwaiter(promise_type& promise) : promise_(&promise) {}

      bool await_ready() const noexcept { return false; }
      void await_suspend(std::coroutine_handle<>) const noexcept {}
      T await_resume() { return promise_->takeInput(); }

     private:
      promise_type* promise_;
    };

    BasicGenerator get_return_object() {
      return BasicGenerator(std::coroutine_handle<promise_type>::from_promise(*this));
    }

    std::suspend_always initial_suspend() const noexcept { return {}; }
    std::suspend_always final_suspend() const noexcept { return {}; }

    YieldAwaiter yield_value(T value) {
      current_.emplace(TaskStorage<T>::store(std::move(value)));
      return YieldAwaiter(*this);
    }

    void return_value(T value) {
      if constexpr (std::is_pointer_v<T>) {
        if (value == nullptr) return;
      }
      returned_.emplace(TaskStorage<T>::store(std::move(value)));
    }

    void unhandled_exception() { error_ = std::current_exception(); }

    T current() const { return TaskStorage<T>::load(*current_); }
    T returned() const {
      return returned_ ? TaskStorage<T>::load(*returned_) : defaultValue<T>();
    }

    void setInput(T value) {
      input_.emplace(TaskStorage<T>::store(std::move(value)));
    }

    T takeInput() const {
      return input_ ? TaskStorage<T>::load(*input_) : defaultValue<T>();
    }

    std::optional<typename TaskStorage<T>::Type> current_;
    std::optional<typename TaskStorage<T>::Type> returned_;
    std::optional<typename TaskStorage<T>::Type> input_;
    std::exception_ptr error_;
  };

  using Handle = std::coroutine_handle<promise_type>;
  using NextResult = std::conditional_t<Async, Ready<GeneratorResult<T>>, GeneratorResult<T>>;

  explicit BasicGenerator(Handle handle) : handle_(handle) {}
  BasicGenerator(const BasicGenerator&) = delete;
  BasicGenerator& operator=(const BasicGenerator&) = delete;

  BasicGenerator(BasicGenerator&& other) noexcept
      : handle_(std::exchange(other.handle_, {})),
        started_(std::exchange(other.started_, false)) {}

  BasicGenerator& operator=(BasicGenerator&& other) noexcept {
    if (this == &other) return *this;
    if (handle_) handle_.destroy();
    handle_ = std::exchange(other.handle_, {});
    started_ = std::exchange(other.started_, false);
    return *this;
  }

  ~BasicGenerator() {
    if (handle_) handle_.destroy();
  }

  NextResult next() {
    if (started_ && handle_ && !handle_.done()) {
      handle_.promise().setInput(defaultValue<T>());
    }
    return wrapNext(nextImmediate());
  }

  NextResult next(T value) {
    if (started_ && handle_ && !handle_.done()) {
      handle_.promise().setInput(std::move(value));
    }
    return wrapNext(nextImmediate());
  }

  NextResult finish() {
    return finish(defaultValue<T>());
  }

  NextResult finish(T value) {
    if (handle_) {
      handle_.destroy();
      handle_ = {};
    }
    started_ = false;
    return wrapNext({true, std::move(value)});
  }

  class Iterator final {
   public:
    explicit Iterator(BasicGenerator* generator) : generator_(generator) { advance(); }

    Iterator& operator++() {
      advance();
      return *this;
    }

    T operator*() const { return result_.value; }
    bool operator!=(std::default_sentinel_t) const { return !result_.done; }

   private:
    void advance() { result_ = generator_->nextImmediate(); }

    BasicGenerator* generator_;
    GeneratorResult<T> result_{true, defaultValue<T>()};
  };

  Iterator begin() { return Iterator(this); }
  std::default_sentinel_t end() const { return {}; }

 private:
  GeneratorResult<T> nextImmediate() {
    if (!handle_ || handle_.done()) {
      return {true, handle_ ? handle_.promise().returned() : defaultValue<T>()};
    }
    started_ = true;
    handle_.resume();
    if (handle_.done()) {
      if (handle_.promise().error_) std::rethrow_exception(handle_.promise().error_);
      return {true, handle_.promise().returned()};
    }
    return {false, handle_.promise().current()};
  }

  NextResult wrapNext(GeneratorResult<T> result) {
    if constexpr (Async) {
      return Ready<GeneratorResult<T>>(std::move(result));
    } else {
      return result;
    }
  }

  Handle handle_;
  bool started_ = false;
};

template <typename T>
using Generator = BasicGenerator<T, false>;

template <typename T>
using AsyncGenerator = BasicGenerator<T, true>;

template <typename Left, typename Right>
inline bool sameValueZero(const Left& left, const Right& right) {
  return left == right;
}

inline bool sameValueZero(double left, double right) {
  return left == right || (std::isnan(left) && std::isnan(right));
}

inline bool sameValueZero(const Value& left, const Value& right) {
  return left == right || (
      left.isNumber() && right.isNumber() &&
      std::isnan(left.number()) && std::isnan(right.number()));
}

template <typename T, typename... Values>
inline double push(std::vector<T>& array, Values&&... values) {
  (array.push_back(std::forward<Values>(values)), ...);
  return static_cast<double>(array.size());
}

template <typename T, typename... Values>
inline double push(ArrayObject<T>* array, Values&&... values) {
  (array->push(static_cast<T>(std::forward<Values>(values))), ...);
  return static_cast<double>(array->size());
}

template <typename T>
inline void appendAll(std::vector<T>& target, const std::vector<T>& source) {
  target.insert(target.end(), source.begin(), source.end());
}

template <typename T>
inline void appendAll(ArrayObject<T>* target, const ArrayObject<T>* source) {
  for (const auto value : *source) target->append(value);
}

template <typename T>
inline void appendAllConverted(Runtime& runtime, std::vector<Value>& target, const std::vector<T>& source) {
  target.reserve(target.size() + source.size());
  for (const auto& value : source) target.push_back(convertValue<Value>(runtime, value));
}

template <typename T>
inline void appendAllConverted(Runtime& runtime, ArrayObject<Value>* target, const ArrayObject<T>* source) {
  for (const auto value : *source) target->append(convertValue<Value>(runtime, value));
}

template <typename T, typename U>
inline bool includes(const std::vector<T>& array, const U& value) {
  return std::any_of(array.begin(), array.end(), [&](const T& element) {
    return sameValueZero(element, value);
  });
}

template <typename T>
template <typename U>
inline bool ArrayObject<T>::includes(const U& value) const {
  for (const auto element : *this) if (sameValueZero(element, value)) return true;
  return false;
}

template <typename T, typename U>
inline bool includes(const ArrayObject<T>* array, const U& value) {
  return array->includes(value);
}

template <typename T, typename U>
inline double indexOf(const std::vector<T>& array, const U& value) {
  const auto iterator = std::find(array.begin(), array.end(), value);
  return iterator == array.end()
      ? -1
      : static_cast<double>(std::distance(array.begin(), iterator));
}

template <typename T>
template <typename U>
inline double ArrayObject<T>::indexOf(const U& value) const {
  for (std::size_t index = 0; index < size(); ++index) {
    if (sameValueZero(get(index), value)) return static_cast<double>(index);
  }
  return -1;
}

template <typename T, typename U>
inline double indexOf(const ArrayObject<T>* array, const U& value) {
  return array->indexOf(value);
}

template <typename T>
inline std::vector<T>& reverse(std::vector<T>& array) {
  std::reverse(array.begin(), array.end());
  return array;
}

template <typename T>
inline ArrayObject<T>* reverse(ArrayObject<T>* array) {
  return array->reverse();
}

template <typename T>
inline T pop(std::vector<T>& array) {
  if (array.empty()) return T{};
  T value = std::move(array.back());
  array.pop_back();
  return value;
}

template <typename T>
inline T pop(ArrayObject<T>* array) {
  return array->pop();
}

template <typename T>
inline T shift(std::vector<T>& array) {
  if (array.empty()) return T{};
  T value = std::move(array.front());
  array.erase(array.begin());
  return value;
}

template <typename T>
inline T shift(ArrayObject<T>* array) {
  return array->shift();
}

template <typename T, typename... Values>
inline double unshift(std::vector<T>& array, Values&&... values) {
  std::vector<T> prefix{std::forward<Values>(values)...};
  array.insert(array.begin(), std::make_move_iterator(prefix.begin()), std::make_move_iterator(prefix.end()));
  return static_cast<double>(array.size());
}

template <typename T, typename... Values>
inline double unshift(ArrayObject<T>* array, Values&&... values) {
  std::vector<T> prefix{static_cast<T>(std::forward<Values>(values))...};
  for (auto iterator = prefix.rbegin(); iterator != prefix.rend(); ++iterator) array->unshift(*iterator);
  return static_cast<double>(array->size());
}

inline std::size_t normalizedSliceIndex(double index, std::size_t size) {
  const auto integer = static_cast<std::int64_t>(index);
  if (integer < 0) return static_cast<std::size_t>(std::max<std::int64_t>(0, static_cast<std::int64_t>(size) + integer));
  return std::min<std::size_t>(static_cast<std::size_t>(integer), size);
}

template <typename T>
inline std::vector<T> slice(const std::vector<T>& array, double start = 0, double end = std::numeric_limits<double>::infinity()) {
  const std::size_t first = normalizedSliceIndex(start, array.size());
  const std::size_t last = std::isinf(end) ? array.size() : normalizedSliceIndex(end, array.size());
  if (last <= first) return {};
  return std::vector<T>(array.begin() + static_cast<std::ptrdiff_t>(first), array.begin() + static_cast<std::ptrdiff_t>(last));
}

template <typename T>
inline ArrayObject<T>* ArrayObject<T>::slice(Runtime& runtime, double start, double end) const {
  auto* result = runtime.array<T>();
  const std::size_t first = normalizedSliceIndex(start, size());
  const std::size_t last = std::isinf(end) ? size() : normalizedSliceIndex(end, size());
  for (std::size_t index = first; index < last; ++index) result->append(get(index));
  return result;
}

template <typename T>
inline ArrayObject<T>* slice(Runtime& runtime, const ArrayObject<T>* array, double start = 0, double end = std::numeric_limits<double>::infinity()) {
  return array->slice(runtime, start, end);
}

template <typename T>
inline std::vector<T> concat(const std::vector<T>& array, const std::vector<T>& other) {
  std::vector<T> result = array;
  result.insert(result.end(), other.begin(), other.end());
  return result;
}

template <typename T>
inline void appendConcatItem(ArrayObject<T>* result, T value) {
  result->append(std::move(value));
}

template <typename T>
inline void appendConcatItem(ArrayObject<T>* result, const ArrayObject<T>* values) {
  appendAll(result, values);
}

template <typename T>
template <typename... Items>
inline ArrayObject<T>* ArrayObject<T>::concat(Runtime& runtime, Items&&... items) const {
  auto* result = runtime.array<T>();
  appendAll(result, this);
  (appendConcatItem(result, std::forward<Items>(items)), ...);
  return result;
}

template <typename T, typename... Items>
inline ArrayObject<T>* concat(Runtime& runtime, const ArrayObject<T>* array, Items&&... items) {
  return array->concat(runtime, std::forward<Items>(items)...);
}

template <typename T, typename Callback>
inline auto map(const std::vector<T>& array, Callback callback)
    -> std::vector<std::remove_cvref_t<std::invoke_result_t<Callback, T>>> {
  using Result = std::remove_cvref_t<std::invoke_result_t<Callback, T>>;
  std::vector<Result> result;
  result.reserve(array.size());
  for (const auto& value : array) result.push_back(callback(value));
  return result;
}

template <typename T>
template <typename Callback>
inline auto ArrayObject<T>::map(Runtime& runtime, Callback callback) const
    -> ArrayObject<std::remove_cvref_t<std::invoke_result_t<Callback, T>>>* {
  using Result = std::remove_cvref_t<std::invoke_result_t<Callback, T>>;
  auto* result = runtime.array<Result>();
  for (const auto value : *this) result->append(callback(value));
  return result;
}

template <typename T, typename Callback>
inline auto map(Runtime& runtime, const ArrayObject<T>* array, Callback callback)
    -> ArrayObject<std::remove_cvref_t<std::invoke_result_t<Callback, T>>>* {
  return array->map(runtime, std::move(callback));
}

template <typename T, typename Callback>
inline std::vector<T> filter(const std::vector<T>& array, Callback callback) {
  std::vector<T> result;
  for (const auto& value : array) if (callback(value)) result.push_back(value);
  return result;
}

template <typename T>
template <typename Callback>
inline ArrayObject<T>* ArrayObject<T>::filter(Runtime& runtime, Callback callback) const {
  auto* result = runtime.array<T>();
  for (const auto value : *this) if (callback(value)) result->append(value);
  return result;
}

template <typename T, typename Callback>
inline ArrayObject<T>* filter(Runtime& runtime, const ArrayObject<T>* array, Callback callback) {
  return array->filter(runtime, std::move(callback));
}

template <typename T, typename Callback, typename Accumulator>
inline Accumulator reduce(const std::vector<T>& array, Callback callback, Accumulator initial) {
  for (const auto& value : array) initial = callback(std::move(initial), value);
  return initial;
}

template <typename T>
template <typename Callback, typename Accumulator>
inline Accumulator ArrayObject<T>::reduce(Callback callback, Accumulator initial) const {
  for (const auto value : *this) initial = callback(std::move(initial), value);
  return initial;
}

template <typename T, typename Callback, typename Accumulator>
inline Accumulator reduce(const ArrayObject<T>* array, Callback callback, Accumulator initial) {
  return array->reduce(std::move(callback), std::move(initial));
}

template <typename T, typename Index>
inline T arrayGet(const ArrayObject<T>* array, Index index) {
  return array->get(static_cast<std::size_t>(index));
}

template <typename T, typename Index, typename U>
inline T arraySet(ArrayObject<T>* array, Index index, U&& value) {
  return array->set(static_cast<std::size_t>(index), static_cast<T>(std::forward<U>(value)));
}

inline std::string numberToString(double value) {
  if (std::isnan(value)) return "NaN";
  if (std::isinf(value)) return value < 0 ? "-Infinity" : "Infinity";
  if (value == 0) return "0";
  std::ostringstream output;
  output << std::setprecision(15) << value;
  return output.str();
}

inline std::string toString(const Value& value) {
  if (value.isUndefined()) return "undefined";
  if (value.isNull()) return "null";
  if (value.isBoolean()) return value.boolean() ? "true" : "false";
  if (value.isNumber()) return numberToString(value.number());
  if (value.isString()) return value.string();
  return "[object Object]";
}

inline std::string toString(double value) { return numberToString(value); }
inline std::string toString(int value) { return std::to_string(value); }
inline std::string toString(std::int64_t value) { return std::to_string(value); }
inline std::string toString(bool value) { return value ? "true" : "false"; }
inline const std::string& toString(const std::string& value) { return value; }

template <typename T>
inline std::string toString(ArrayObject<T>* array);

[[noreturn]] inline void throwValue(const Error& error) {
  throw std::runtime_error(error.message());
}

template <typename T>
[[noreturn]] inline void throwValue(const T& value) {
  throw std::runtime_error(toString(value));
}

template <typename Result>
struct PromiseResult final {
  using Type = std::remove_cvref_t<Result>;
  static constexpr bool task = false;
};

template <typename Result>
struct PromiseResult<Task<Result>> final {
  using Type = Result;
  static constexpr bool task = true;
};

template <typename Input>
Task<std::remove_cvref_t<Input>> resolvedTask(Runtime& runtime, Input value) {
  co_return std::move(value);
}

template <typename Result, typename Reason>
Task<Result> rejectedTask(Runtime& runtime, const Reason& reason) {
  throwValue(reason);
  co_return defaultValue<Result>();
}

template <typename T>
Task<ArrayObject<T>*> promiseAll(Runtime& runtime, ArrayObject<Task<T>>* tasks) {
  cppgc::Persistent<ArrayObject<Task<T>>> rootedTasks(tasks);
  auto* values = runtime.array<T>();
  cppgc::Persistent<ArrayObject<T>> rootedValues(values);
  for (auto task : *tasks) values->append(co_await task);
  co_return values;
}

template <typename T, typename Callback>
Task<typename PromiseResult<std::invoke_result_t<Callback, T>>::Type> promiseThen(
    Runtime& runtime,
    Task<T> source,
    Callback callback) {
  using CallbackResult = std::invoke_result_t<Callback, T>;
  using Result = typename PromiseResult<CallbackResult>::Type;
  T value = co_await source;
  if constexpr (PromiseResult<CallbackResult>::task) {
    if constexpr (std::is_void_v<Result>) {
      co_await callback(std::move(value));
      co_return;
    } else {
      co_return co_await callback(std::move(value));
    }
  } else if constexpr (std::is_void_v<CallbackResult>) {
    callback(std::move(value));
    co_return;
  } else {
    co_return callback(std::move(value));
  }
}

template <typename Callback>
Task<typename PromiseResult<std::invoke_result_t<Callback>>::Type> promiseThen(
    Runtime& runtime,
    Task<void> source,
    Callback callback) {
  using CallbackResult = std::invoke_result_t<Callback>;
  using Result = typename PromiseResult<CallbackResult>::Type;
  co_await source;
  if constexpr (PromiseResult<CallbackResult>::task) {
    if constexpr (std::is_void_v<Result>) {
      co_await callback();
      co_return;
    } else {
      co_return co_await callback();
    }
  } else if constexpr (std::is_void_v<CallbackResult>) {
    callback();
    co_return;
  } else {
    co_return callback();
  }
}

template <typename T, typename Callback>
Task<T> promiseCatch(Runtime& runtime, Task<T> source, Callback callback) {
  std::string message;
  try {
    co_return co_await source;
  } catch (const std::exception& error) {
    message = error.what();
  }
  using CallbackResult = std::invoke_result_t<Callback, Value>;
  if constexpr (PromiseResult<CallbackResult>::task) {
    co_return co_await callback(runtime.string(std::move(message)));
  } else {
    co_return callback(runtime.string(std::move(message)));
  }
}

template <typename T, typename Callback>
Task<T> promiseFinally(Runtime& runtime, Task<T> source, Callback callback) {
  std::optional<typename TaskStorage<T>::Type> value;
  std::exception_ptr error;
  try {
    value.emplace(TaskStorage<T>::store(co_await source));
  } catch (...) {
    error = std::current_exception();
  }
  using CallbackResult = std::invoke_result_t<Callback>;
  if constexpr (PromiseResult<CallbackResult>::task) co_await callback();
  else callback();
  if (error) std::rethrow_exception(error);
  co_return TaskStorage<T>::load(*value);
}

template <typename T>
inline std::string joinWithSeparator(const std::vector<T>& array, const std::string& separator) {
  std::ostringstream output;
  for (std::size_t index = 0; index < array.size(); ++index) {
    if (index > 0) output << separator;
    output << toString(array[index]);
  }
  return output.str();
}

template <typename T>
inline std::string joinWithSeparator(const ArrayObject<T>* array, const std::string& separator) {
  std::ostringstream output;
  for (std::size_t index = 0; index < array->size(); ++index) {
    if (index > 0) output << separator;
    output << toString(array->get(index));
  }
  return output.str();
}

template <typename T>
inline std::string ArrayObject<T>::join(const std::string& separator) const {
  return joinWithSeparator(this, separator);
}

template <typename T>
inline std::string join(const std::vector<T>& array) {
  return joinWithSeparator(array, ",");
}

template <typename T>
inline std::string join(const ArrayObject<T>* array) {
  return array->join();
}

template <typename T, typename Separator>
inline std::string join(const std::vector<T>& array, const Separator& separator) {
  return joinWithSeparator(array, toString(separator));
}

template <typename T, typename Separator>
inline std::string join(const ArrayObject<T>* array, const Separator& separator) {
  return array->join(toString(separator));
}

template <typename T>
inline std::string ArrayObject<T>::toString() const {
  return "[" + join(", ") + "]";
}

template <typename T>
inline std::string toString(ArrayObject<T>* array) {
  return array ? array->toString() : "null";
}

template <typename T>
inline std::string toString(const cppgc::Member<ArrayObject<T>>& array) {
  return toString(array.Get());
}

template <typename T>
inline std::string toString(const cppgc::Persistent<ArrayObject<T>>& array) {
  return toString(array.Get());
}

inline bool includes(const std::vector<std::string>& array, const Value& value) {
  return includes(array, toString(value));
}

inline bool includes(const ArrayObject<std::string>* array, const Value& value) {
  return includes(array, toString(value));
}

inline double indexOf(const std::vector<std::string>& array, const Value& value) {
  return indexOf(array, toString(value));
}

inline double indexOf(const ArrayObject<std::string>* array, const Value& value) {
  return indexOf(array, toString(value));
}

template <typename... Values>
inline double push(std::vector<std::string>& array, Values&&... values) {
  (array.push_back(toString(std::forward<Values>(values))), ...);
  return static_cast<double>(array.size());
}

template <typename... Values>
inline double push(ArrayObject<std::string>* array, Values&&... values) {
  (array->append(toString(std::forward<Values>(values))), ...);
  return static_cast<double>(array->size());
}

inline double valueOf(double value) { return value; }
inline bool valueOf(bool value) { return value; }
inline const Value& valueOf(const Value& value) { return value; }

inline std::string toFixed(double value, int digits = 0) {
  std::ostringstream output;
  output << std::fixed << std::setprecision(std::clamp(digits, 0, 100)) << value;
  return output.str();
}

inline std::string toUpperCase(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
    return static_cast<char>(std::toupper(character));
  });
  return value;
}
inline std::string toUpperCase(const Value& value) { return toUpperCase(toString(value)); }

inline std::string toLowerCase(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
    return static_cast<char>(std::tolower(character));
  });
  return value;
}
inline std::string toLowerCase(const Value& value) { return toLowerCase(toString(value)); }

inline std::string trim(std::string value) {
  const auto isSpace = [](unsigned char character) { return std::isspace(character) != 0; };
  value.erase(value.begin(), std::find_if_not(value.begin(), value.end(), isSpace));
  value.erase(std::find_if_not(value.rbegin(), value.rend(), isSpace).base(), value.end());
  return value;
}
inline std::string trim(const Value& value) { return trim(toString(value)); }

inline bool stringIncludes(const std::string& value, const std::string& search, double position = 0) {
  return value.find(search, normalizedSliceIndex(position, value.size())) != std::string::npos;
}
inline bool stringIncludes(const Value& value, const Value& search, double position = 0) {
  return stringIncludes(toString(value), toString(search), position);
}

inline bool startsWith(const std::string& value, const std::string& search, double position = 0) {
  return value.compare(normalizedSliceIndex(position, value.size()), search.size(), search) == 0;
}
inline bool startsWith(const Value& value, const Value& search, double position = 0) {
  return startsWith(toString(value), toString(search), position);
}

inline bool endsWith(const std::string& value, const std::string& search) {
  return search.size() <= value.size() && value.compare(value.size() - search.size(), search.size(), search) == 0;
}
inline bool endsWith(const Value& value, const Value& search) {
  return endsWith(toString(value), toString(search));
}

inline std::string charAt(const std::string& value, double index = 0) {
  const auto position = static_cast<std::int64_t>(index);
  return position >= 0 && static_cast<std::size_t>(position) < value.size()
      ? value.substr(static_cast<std::size_t>(position), 1)
      : "";
}
inline std::string charAt(const Value& value, double index = 0) { return charAt(toString(value), index); }

inline std::string substring(const std::string& value, double start, double end = std::numeric_limits<double>::infinity()) {
  std::size_t first = normalizedSliceIndex(std::max(0.0, start), value.size());
  std::size_t last = std::isinf(end) ? value.size() : normalizedSliceIndex(std::max(0.0, end), value.size());
  if (first > last) std::swap(first, last);
  return value.substr(first, last - first);
}
inline std::string substring(const Value& value, double start, double end = std::numeric_limits<double>::infinity()) {
  return substring(toString(value), start, end);
}

inline std::string stringSlice(const std::string& value, double start, double end = std::numeric_limits<double>::infinity()) {
  const std::size_t first = normalizedSliceIndex(start, value.size());
  const std::size_t last = std::isinf(end) ? value.size() : normalizedSliceIndex(end, value.size());
  return last <= first ? "" : value.substr(first, last - first);
}
inline std::string stringSlice(const Value& value, double start, double end = std::numeric_limits<double>::infinity()) {
  return stringSlice(toString(value), start, end);
}

inline ArrayObject<std::string>* split(Runtime& runtime, const std::string& value, const std::string& separator) {
  auto* result = runtime.array<std::string>();
  if (separator.empty()) {
    for (char character : value) result->append(std::string(1, character));
    return result;
  }
  std::size_t start = 0;
  while (true) {
    const std::size_t next = value.find(separator, start);
    if (next == std::string::npos) {
      result->append(value.substr(start));
      return result;
    }
    result->append(value.substr(start, next - start));
    start = next + separator.size();
  }
}
inline ArrayObject<std::string>* split(Runtime& runtime, const Value& value, const Value& separator) {
  return split(runtime, toString(value), toString(separator));
}

inline double Number(double value) { return value; }
inline double Number(bool value) { return value ? 1 : 0; }
inline double Number(const Value& value) {
  if (value.isNumber()) return value.number();
  if (value.isBoolean()) return value.boolean() ? 1 : 0;
  if (value.isNull()) return 0;
  if (value.isUndefined()) return std::numeric_limits<double>::quiet_NaN();
  if (!value.isString()) return std::numeric_limits<double>::quiet_NaN();
  try {
    return std::stod(value.string());
  } catch (...) {
    return std::numeric_limits<double>::quiet_NaN();
  }
}

template <typename T>
inline std::string String(const T& value) {
  return toString(value);
}

inline bool Boolean(bool value) { return value; }
inline bool Boolean(double value) { return value != 0 && !std::isnan(value); }
inline bool Boolean(const Value& value) {
  if (value.isUndefined() || value.isNull()) return false;
  if (value.isBoolean()) return value.boolean();
  if (value.isNumber()) return Boolean(value.number());
  return !value.isString() || !value.string().empty();
}

template <typename T>
inline bool Boolean(T* value) {
  return value != nullptr;
}

template <typename T>
inline bool Boolean(const std::vector<T>&) {
  return true;
}

template <typename Left, typename Right>
inline Value add(Runtime& runtime, Left&& leftInput, Right&& rightInput) {
  const Value left = convertValue<Value>(runtime, std::forward<Left>(leftInput));
  const Value right = convertValue<Value>(runtime, std::forward<Right>(rightInput));
  if (left.isString() || right.isString()) {
    return runtime.string(toString(left) + toString(right));
  }
  return Value(Number(left) + Number(right));
}

template <typename Right>
inline Value& addAssign(Runtime& runtime, Value& left, Right&& right) {
  left = add(runtime, left, std::forward<Right>(right));
  return left;
}

template <typename Target, typename Callback>
inline Target& assignWith(Target& target, Callback&& callback) {
  target = std::forward<Callback>(callback)(target);
  return target;
}

template <typename Left, typename Right>
inline std::int32_t compare(const Left& left, const Right& right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

inline std::int32_t compare(const Value& left, const Value& right) {
  if (left.isString() && right.isString()) {
    return compare(left.string(), right.string());
  }
  return compare(Number(left), Number(right));
}

inline double parseFloat(const std::string& value) {
  try {
    return std::stod(value);
  } catch (...) {
    return std::numeric_limits<double>::quiet_NaN();
  }
}

inline double parseFloat(const Value& value) { return parseFloat(toString(value)); }
inline double parseInt(const std::string& value, int radix = 10) {
  try {
    return static_cast<double>(std::stoll(value, nullptr, radix));
  } catch (...) {
    return std::numeric_limits<double>::quiet_NaN();
  }
}
inline double parseInt(const Value& value, int radix = 10) { return parseInt(toString(value), radix); }
inline bool isNaN(double value) { return std::isnan(value); }
inline bool isFinite(double value) { return std::isfinite(value); }

inline std::string typeOf(const Value& value) {
  if (value.isUndefined()) return "undefined";
  if (value.isBoolean()) return "boolean";
  if (value.isNumber()) return "number";
  if (value.isString()) return "string";
  return "object";
}
inline std::string typeOf(double) { return "number"; }
inline std::string typeOf(bool) { return "boolean"; }
inline std::string typeOf(const std::string&) { return "string"; }

struct Math final {
  static constexpr double E = 2.71828182845904523536;
  static constexpr double LN2 = 0.69314718055994530942;
  static constexpr double LN10 = 2.30258509299404568402;
  static constexpr double PI = 3.14159265358979323846;
  static constexpr double SQRT2 = 1.41421356237309504880;

  static double abs(double value) { return std::abs(value); }
  static double acos(double value) { return std::acos(value); }
  static double asin(double value) { return std::asin(value); }
  static double atan(double value) { return std::atan(value); }
  static double atan2(double y, double x) { return std::atan2(y, x); }
  static double ceil(double value) { return std::ceil(value); }
  static double cos(double value) { return std::cos(value); }
  static double exp(double value) { return std::exp(value); }
  static double floor(double value) { return std::floor(value); }
  static double log(double value) { return std::log(value); }
  static double log2(double value) { return std::log2(value); }
  static double log10(double value) { return std::log10(value); }
  static double round(double value) { return std::round(value); }
  static double sign(double value) { return (0 < value) - (value < 0); }
  static double sin(double value) { return std::sin(value); }
  static double sqrt(double value) { return std::sqrt(value); }
  static double tan(double value) { return std::tan(value); }
  static double trunc(double value) { return std::trunc(value); }
  static double pow(double base, double exponent) { return std::pow(base, exponent); }
  static double min(double left, double right) { return std::min(left, right); }
  static double max(double left, double right) { return std::max(left, right); }
  static double hypot(double left, double right) { return std::hypot(left, right); }
  static double random() {
    return static_cast<double>(std::rand()) / static_cast<double>(RAND_MAX);
  }
};

class Console final {
 public:
  template <typename... Arguments>
  void log(const Arguments&... arguments) const {
    write(std::cout, arguments...);
  }

  template <typename... Arguments>
  void info(const Arguments&... arguments) const {
    write(std::cout, arguments...);
  }

  template <typename... Arguments>
  void warn(const Arguments&... arguments) const {
    write(std::cerr, arguments...);
  }

  template <typename... Arguments>
  void error(const Arguments&... arguments) const {
    write(std::cerr, arguments...);
  }

 private:
  static void print(std::ostream& output, const Value& value) { output << toString(value); }
  static void print(std::ostream& output, const std::string& value) { output << value; }
  static void print(std::ostream& output, const char* value) { output << value; }
  static void print(std::ostream& output, bool value) { output << (value ? "true" : "false"); }
  static void print(std::ostream& output, double value) { output << numberToString(value); }
  static void print(std::ostream& output, float value) { output << numberToString(value); }

  template <typename T>
  static void print(std::ostream& output, ArrayObject<T>* values) {
    output << toString(values);
  }

  template <typename T>
  static void print(std::ostream& output, const cppgc::Member<ArrayObject<T>>& values) {
    output << toString(values);
  }

  template <typename T>
  static void print(std::ostream& output, const cppgc::Persistent<ArrayObject<T>>& values) {
    output << toString(values);
  }

  template <typename T>
  static void print(std::ostream& output, const T& value) {
    output << value;
  }

  template <typename T>
  static void print(std::ostream& output, const std::vector<T>& values) {
    output << '[';
    for (std::size_t index = 0; index < values.size(); ++index) {
      if (index > 0) output << ", ";
      print(output, values[index]);
    }
    output << ']';
  }

  template <typename... Arguments>
  static void write(std::ostream& output, const Arguments&... arguments) {
    bool first = true;
    const auto printArgument = [&](const auto& argument) {
      if (!first) output << ' ';
      first = false;
      print(output, argument);
    };
    (printArgument(arguments), ...);
    output << '\n';
  }
};

inline const Console console;

}  // namespace vexa
