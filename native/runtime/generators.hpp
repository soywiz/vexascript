#pragma once

// Internal runtime category header. Include runtime.hpp instead.

template <typename T>
inline ArrayObject<T>* arrayWithLength(double length) {
  auto* result = Runtime::array<T>();
  const auto size = static_cast<std::size_t>(std::max(0.0, std::floor(length)));
  for (std::size_t index = 0; index < size; ++index) result->append(defaultValue<T>());
  return result;
}

template <>
Value defaultValue<Value>();

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

  BasicGenerator() = default;
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

template <typename T>
inline ArrayObject<T>* iteratorFrom(BasicGenerator<T, false> iterator) {
  auto* result = Runtime::array<T>();
  for (const auto& value : iterator) result->append(value);
  return result;
}

template <typename T>
inline ArrayObject<T>* iteratorFrom(const ArrayObject<T>* values) {
  return values ? values->slice() : Runtime::array<T>();
}
