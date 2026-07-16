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
#include <iostream>
#include <iterator>
#include <limits>
#include <memory>
#include <optional>
#include <queue>
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

class Value final {
 public:
  using Storage = std::variant<Undefined, Null, bool, double, cppgc::Persistent<StringObject>>;

  Value() : storage_(Undefined{}) {}
  Value(bool value) : storage_(value) {}
  Value(double value) : storage_(value) {}
  Value(int value) : storage_(static_cast<double>(value)) {}
  explicit Value(StringObject* value) : storage_(cppgc::Persistent<StringObject>(value)) {}

  static Value undefined() { return Value(); }
  static Value null() { return Value(Null{}); }

  bool isUndefined() const { return std::holds_alternative<Undefined>(storage_); }
  bool isNull() const { return std::holds_alternative<Null>(storage_); }
  bool isBoolean() const { return std::holds_alternative<bool>(storage_); }
  bool isNumber() const { return std::holds_alternative<double>(storage_); }
  bool isString() const { return std::holds_alternative<cppgc::Persistent<StringObject>>(storage_); }

  bool boolean() const { return std::get<bool>(storage_); }
  double number() const { return std::get<double>(storage_); }
  const std::string& string() const {
    return std::get<cppgc::Persistent<StringObject>>(storage_)->value();
  }

  bool operator==(const Value& other) const {
    if (storage_.index() != other.storage_.index()) return false;
    if (isUndefined() || isNull()) return true;
    if (isBoolean()) return boolean() == other.boolean();
    if (isNumber()) return number() == other.number();
    return string() == other.string();
  }

 private:
  explicit Value(Null value) : storage_(value) {}
  Storage storage_;
};

class Error final {
 public:
  explicit Error(const Value& value)
      : message_(value.isString() ? value.string() : "Error") {}
  explicit Error(std::string message) : message_(std::move(message)) {}

  const std::string& message() const { return message_; }

 private:
  std::string message_;
};

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
  } else {
    return std::forward<Input>(input);
  }
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
class Task final {
 public:
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

 private:
  struct State final {
    Runtime* runtime = nullptr;
    std::optional<typename TaskStorage<T>::Type> value;
    std::exception_ptr error;
    bool settled = false;
  };

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
  }

  static void reject(const std::shared_ptr<State>& state, std::exception_ptr error) {
    if (state->settled) return;
    state->error = std::move(error);
    state->settled = true;
  }

  explicit Task(std::shared_ptr<State> state) : state_(std::move(state)) {}

  std::shared_ptr<State> state_;
};

template <>
class Task<void> final {
 public:
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

 private:
  struct State final {
    Runtime* runtime = nullptr;
    std::exception_ptr error;
    bool settled = false;
  };

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
  }

  static void reject(const std::shared_ptr<State>& state, std::exception_ptr error) {
    if (state->settled) return;
    state->error = std::move(error);
    state->settled = true;
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

template <typename T, typename U>
inline bool includes(const std::vector<T>& array, const U& value) {
  return std::any_of(array.begin(), array.end(), [&](const T& element) {
    return sameValueZero(element, value);
  });
}

template <typename T, typename U>
inline double indexOf(const std::vector<T>& array, const U& value) {
  const auto iterator = std::find(array.begin(), array.end(), value);
  return iterator == array.end()
      ? -1
      : static_cast<double>(std::distance(array.begin(), iterator));
}

template <typename T>
inline std::vector<T>& reverse(std::vector<T>& array) {
  std::reverse(array.begin(), array.end());
  return array;
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
  return value.string();
}

inline std::string toString(double value) { return numberToString(value); }
inline std::string toString(int value) { return std::to_string(value); }
inline std::string toString(std::int64_t value) { return std::to_string(value); }
inline std::string toString(bool value) { return value ? "true" : "false"; }
inline const std::string& toString(const std::string& value) { return value; }

[[noreturn]] inline void throwValue(const Error& error) {
  throw std::runtime_error(error.message());
}

template <typename T>
[[noreturn]] inline void throwValue(const T& value) {
  throw std::runtime_error(toString(value));
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
inline std::string join(const std::vector<T>& array) {
  return joinWithSeparator(array, ",");
}

template <typename T, typename Separator>
inline std::string join(const std::vector<T>& array, const Separator& separator) {
  return joinWithSeparator(array, toString(separator));
}

inline bool includes(const std::vector<std::string>& array, const Value& value) {
  return includes(array, toString(value));
}

inline double indexOf(const std::vector<std::string>& array, const Value& value) {
  return indexOf(array, toString(value));
}

template <typename... Values>
inline double push(std::vector<std::string>& array, Values&&... values) {
  (array.push_back(toString(std::forward<Values>(values))), ...);
  return static_cast<double>(array.size());
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

inline double Number(double value) { return value; }
inline double Number(bool value) { return value ? 1 : 0; }
inline double Number(const Value& value) {
  if (value.isNumber()) return value.number();
  if (value.isBoolean()) return value.boolean() ? 1 : 0;
  if (value.isNull()) return 0;
  if (value.isUndefined()) return std::numeric_limits<double>::quiet_NaN();
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
  return !value.string().empty();
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
  static void print(std::ostream& output, const T& value) {
    output << value;
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
