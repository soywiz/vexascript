#pragma once

// Internal runtime category header. Include runtime.hpp instead.

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
class ReturnSignal<void> final {
 public:
  void value() const;
};

template <typename T, typename Callback>
[[noreturn]] inline void throwReturn(Callback&& callback) {
  if constexpr (std::is_void_v<T>) {
    std::forward<Callback>(callback)();
    throw ReturnSignal<void>();
  } else {
    throw ReturnSignal<T>(convertValue<T>(std::forward<Callback>(callback)()));
  }
}

class BreakSignal final {};
class ContinueSignal final {};
class LabeledBreakSignal final {
 public:
  explicit LabeledBreakSignal(std::u16string label);
  const std::u16string& label() const;
 private:
  std::u16string label_;
};
class LabeledContinueSignal final {
 public:
  explicit LabeledContinueSignal(std::u16string label);
  const std::u16string& label() const;
 private:
  std::u16string label_;
};

class RejectedValue final {
 public:
  explicit RejectedValue(Value reason);
  const Value& reason() const;

 private:
  Value reason_;
};

// Keep task state ownership independent of standard-library control-block
// vtables, which are not reliably emitted for the single-translation-unit build.
template <typename State>
class TaskStateHandle final {
 public:
  TaskStateHandle() : control_(new Control()) {}

  TaskStateHandle(const TaskStateHandle& other) noexcept
      : control_(other.control_) {
    retain();
  }

  TaskStateHandle(TaskStateHandle&& other) noexcept
      : control_(std::exchange(other.control_, nullptr)) {}

  TaskStateHandle& operator=(TaskStateHandle other) noexcept {
    std::swap(control_, other.control_);
    return *this;
  }

  ~TaskStateHandle() { release(); }

  State* operator->() const {
    return &control_->state;
  }

 private:
  struct Control final {
    std::atomic<std::size_t> references{1};
    State state;
  };

  void retain() noexcept {
    if (control_) control_->references.fetch_add(1, std::memory_order_relaxed);
  }

  void release() noexcept {
    if (control_ &&
        control_->references.fetch_sub(1, std::memory_order_acq_rel) == 1) {
      delete control_;
    }
  }

  Control* control_;
};

template <typename T>
class Task final {
 public:
  struct State final {
    std::optional<typename TaskStorage<T>::Type> value;
    std::exception_ptr error;
    std::vector<std::function<void()>> continuations;
    bool settled = false;
  };

  struct promise_type final {
    promise_type() : state(makeState()) {}

    template <typename... Arguments>
    explicit promise_type(Arguments&&...) : state(makeState()) {}

    template <typename Owner, typename... Arguments>
    promise_type(Owner&, Arguments&&...) : state(makeState()) {}

    Task get_return_object() { return Task(state); }
    std::suspend_never initial_suspend() const noexcept { return {}; }
    std::suspend_never final_suspend() const noexcept { return {}; }
    void return_value(T value) { resolve(state, std::move(value)); }
    void unhandled_exception() { reject(state, std::current_exception()); }

    TaskStateHandle<State> state;
  };

  Task() = default;

  class Awaiter final {
   public:
    explicit Awaiter(TaskStateHandle<State> state) : state_(std::move(state)) {}
    bool await_ready() const noexcept { return state_->settled; }
    void await_suspend(std::coroutine_handle<> continuation) {
      onSettled(state_, [continuation]() mutable { continuation.resume(); });
    }
    T await_resume() const {
      if (state_->error) std::rethrow_exception(state_->error);
      return TaskStorage<T>::load(*state_->value);
    }

   private:
    TaskStateHandle<State> state_;
  };

  template <typename Executor>
  static Task create(Executor executor) {
    auto state = makeState();
    try {
      executor(Resolver(state), Rejecter(state));
    } catch (...) {
      reject(state, std::current_exception());
    }
    return Task(std::move(state));
  }

  template <typename Work>
  static Task schedule(Work work) {
    auto state = makeState();
    Runtime::enqueueMicrotask([state, work = std::move(work)]() mutable {
      try {
        resolve(state, work());
      } catch (...) {
        reject(state, std::current_exception());
      }
    });
    return Task(std::move(state));
  }

  T get() const {
    Runtime::runUntil([this] { return state_->settled; });
    if (state_->error) std::rethrow_exception(state_->error);
    return TaskStorage<T>::load(*state_->value);
  }

  Awaiter operator co_await() const { return Awaiter(state_); }

  void whenSettled(std::function<void()> continuation) const {
    onSettled(state_, std::move(continuation));
  }

  T settledValue() const {
    if (!state_->settled) throw runtimeError(u"Promise is not settled");
    if (state_->error) std::rethrow_exception(state_->error);
    return TaskStorage<T>::load(*state_->value);
  }

  std::exception_ptr settledError() const { return state_->error; }

 private:
  class Resolver final {
   public:
    explicit Resolver(TaskStateHandle<State> state) : state_(std::move(state)) {}

    void operator()() const {
      if constexpr (std::is_same_v<T, Value>) {
        resolve(state_, Value::undefined());
      } else {
        resolve(state_, T{});
      }
    }

    void operator()(T value) const { resolve(state_, std::move(value)); }

   private:
    TaskStateHandle<State> state_;
  };

  class Rejecter final {
   public:
    explicit Rejecter(TaskStateHandle<State> state) : state_(std::move(state)) {}

    void operator()() const {
      reject(state_, std::make_exception_ptr(runtimeError(u"Promise rejected")));
    }

    void operator()(const Error& error) const {
      reject(state_, std::make_exception_ptr(RejectedValue(Runtime::string(error.messageText()))));
    }

    template <typename Reason>
      requires (!std::is_same_v<std::remove_cvref_t<Reason>, Error>)
    void operator()(Reason&& reason) const {
      reject(state_, std::make_exception_ptr(RejectedValue(
          convertValue<Value>(std::forward<Reason>(reason)))));
    }

   private:
    TaskStateHandle<State> state_;
  };

  static TaskStateHandle<State> makeState() {
    return TaskStateHandle<State>();
  }

  static void resolve(const TaskStateHandle<State>& state, T value) {
    if (state->settled) return;
    state->value.emplace(TaskStorage<T>::store(std::move(value)));
    state->settled = true;
    notify(state);
  }

  static void reject(const TaskStateHandle<State>& state, std::exception_ptr error) {
    if (state->settled) return;
    state->error = std::move(error);
    state->settled = true;
    notify(state);
  }

  static void onSettled(const TaskStateHandle<State>& state, std::function<void()> continuation) {
    if (state->settled) Runtime::enqueueMicrotask(std::move(continuation));
    else state->continuations.push_back(std::move(continuation));
  }

  static void notify(const TaskStateHandle<State>& state) {
    for (auto& continuation : state->continuations) {
      Runtime::enqueueMicrotask(std::move(continuation));
    }
    state->continuations.clear();
  }

  explicit Task(TaskStateHandle<State> state) : state_(std::move(state)) {}

  TaskStateHandle<State> state_;
};

template <>
class Task<void> final {
 public:
  struct State final {
    std::exception_ptr error;
    std::vector<std::function<void()>> continuations;
    bool settled = false;
  };

  struct promise_type final {
    promise_type();

    template <typename... Arguments>
    explicit promise_type(Arguments&&...) : state(makeState()) {}

    template <typename Owner, typename... Arguments>
    promise_type(Owner&, Arguments&&...) : state(makeState()) {}

    Task get_return_object();
    std::suspend_never initial_suspend() const noexcept;
    std::suspend_never final_suspend() const noexcept;
    void return_void();
    void unhandled_exception();

    TaskStateHandle<State> state;
  };

  Task();

  class Awaiter final {
   public:
    explicit Awaiter(TaskStateHandle<State> state);
    bool await_ready() const noexcept;
    void await_suspend(std::coroutine_handle<> continuation);
    void await_resume() const;

   private:
    TaskStateHandle<State> state_;
  };

  template <typename Executor>
  static Task create(Executor executor) {
    auto state = makeState();
    try {
      executor(Resolver(state), Rejecter(state));
    } catch (...) {
      reject(state, std::current_exception());
    }
    return Task(std::move(state));
  }

  template <typename Work>
  static Task schedule(Work work) {
    auto state = makeState();
    Runtime::enqueueMicrotask([state, work = std::move(work)]() mutable {
      try {
        work();
        resolve(state);
      } catch (...) {
        reject(state, std::current_exception());
      }
    });
    return Task(std::move(state));
  }

  void get() const;

  Awaiter operator co_await() const;

  void whenSettled(std::function<void()> continuation) const;

  void settledValue() const;

  std::exception_ptr settledError() const;

 private:
  class Resolver final {
   public:
    explicit Resolver(TaskStateHandle<State> state);
    void operator()() const;

   private:
    TaskStateHandle<State> state_;
  };

  class Rejecter final {
   public:
    explicit Rejecter(TaskStateHandle<State> state);

    void operator()() const;

    void operator()(const Error& error) const;

    template <typename Reason>
      requires (!std::is_same_v<std::remove_cvref_t<Reason>, Error>)
    void operator()(Reason&& reason) const {
      reject(state_, std::make_exception_ptr(RejectedValue(
          convertValue<Value>(std::forward<Reason>(reason)))));
    }

   private:
    TaskStateHandle<State> state_;
  };

  static TaskStateHandle<State> makeState();

  static void resolve(const TaskStateHandle<State>& state);

  static void reject(const TaskStateHandle<State>& state, std::exception_ptr error);

  static void onSettled(const TaskStateHandle<State>& state, std::function<void()> continuation);

  static void notify(const TaskStateHandle<State>& state);

  explicit Task(TaskStateHandle<State> state);

  TaskStateHandle<State> state_;
};

template <typename Work, typename Map>
auto runAsyncMapped(Work work, Map map)
    -> Task<std::invoke_result_t<Map, std::invoke_result_t<Work>>> {
  using Result = std::invoke_result_t<Map, std::invoke_result_t<Work>>;
  auto operation = std::async(std::launch::async, std::move(work)).share();
  return Task<Result>::create([operation = std::move(operation), map = std::move(map)](auto resolve, auto reject) mutable {
    Runtime::enqueueIo([operation = std::move(operation), map = std::move(map), resolve, reject]() mutable {
      if (operation.wait_for(std::chrono::seconds(0)) != std::future_status::ready) return false;
      try {
        if constexpr (std::is_void_v<Result>) {
          operation.get();
          map();
          resolve();
        } else {
          resolve(map(operation.get()));
        }
      } catch (const std::exception& error) {
        reject(Error(exceptionText(error)));
      }
      return true;
    });
  });
}

template <typename Callback>
auto blockingCallback(Callback callback) {
  return [callback = std::move(callback)](auto&&... arguments) mutable -> decltype(auto) {
    return callback(std::forward<decltype(arguments)>(arguments)...).get();
  };
}

template <typename Work>
auto runAsync(Work work) -> Task<std::invoke_result_t<Work>> {
  using Result = std::invoke_result_t<Work>;
  if constexpr (std::is_void_v<Result>) {
    auto operation = std::async(std::launch::async, std::move(work)).share();
    return Task<void>::create([operation = std::move(operation)](auto resolve, auto reject) mutable {
      Runtime::enqueueIo([operation = std::move(operation), resolve, reject]() mutable {
        if (operation.wait_for(std::chrono::seconds(0)) != std::future_status::ready) return false;
        try {
          operation.get();
          resolve();
        } catch (const std::exception& error) {
          reject(Error(exceptionText(error)));
        }
        return true;
      });
    });
  } else {
    return runAsyncMapped(std::move(work), [](Result value) { return value; });
  }
}
