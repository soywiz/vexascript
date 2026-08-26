#pragma once

// Internal runtime category header. Include runtime.hpp instead.

template <typename Result>
struct PromiseResult final {
  using Type = std::remove_cvref_t<Result>;
  static constexpr bool task = false;
};

template <typename Result>
struct PromiseResult<Task<Result>> final {
  using Type = typename PromiseResult<Result>::Type;
  static constexpr bool task = true;
};

template <typename Result>
Task<typename PromiseResult<Result>::Type> assimilateTask(Task<Result> task) {
  if constexpr (PromiseResult<Result>::task) {
    auto nested = co_await task;
    if constexpr (std::is_void_v<typename PromiseResult<Result>::Type>) {
      co_await assimilateTask(std::move(nested));
      co_return;
    } else {
      co_return co_await assimilateTask(std::move(nested));
    }
  } else if constexpr (std::is_void_v<Result>) {
    co_await task;
    co_return;
  } else {
    co_return co_await task;
  }
}

template <typename Input>
Task<std::remove_cvref_t<Input>> resolvedTask(Input value) {
  co_return std::move(value);
}

template <typename Input>
Task<std::remove_cvref_t<Input>> promiseResolve(Input value) {
  co_return std::move(value);
}

template <typename Result>
Task<typename PromiseResult<Result>::Type> promiseResolve(Task<Result> task) {
  if constexpr (std::is_void_v<typename PromiseResult<Result>::Type>) {
    co_await assimilateTask(std::move(task));
    co_return;
  } else {
    co_return co_await assimilateTask(std::move(task));
  }
}

template <typename Result, typename Reason>
Task<Result> rejectedTask(const Reason& reason) {
  throwValue(reason);
  co_return defaultValue<Result>();
}

template <typename Callback, typename... Arguments>
auto promiseTry(Callback callback, Arguments... arguments)
    -> Task<typename PromiseResult<std::invoke_result_t<Callback, Arguments...>>::Type> {
  using CallbackResult = std::invoke_result_t<Callback, Arguments...>;
  using Result = typename PromiseResult<CallbackResult>::Type;
  if constexpr (PromiseResult<CallbackResult>::task) {
    if constexpr (std::is_void_v<Result>) {
      co_await assimilateTask(callback(std::move(arguments)...));
      co_return;
    } else {
      co_return co_await assimilateTask(callback(std::move(arguments)...));
    }
  } else if constexpr (std::is_void_v<CallbackResult>) {
    callback(std::move(arguments)...);
    co_return;
  } else {
    co_return callback(std::move(arguments)...);
  }
}

template <typename T>
class PromiseResolvers final
    : public cppgc::GarbageCollected<PromiseResolvers<T>>, public BaseObject {
 public:
  Task<T> promise;
  std::function<void(T)> resolve;
  std::function<void(Value)> reject;

  const void* dynamicTypeToken() const override { return nativeTypeToken<PromiseResolvers<T>>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<PromiseResolvers<T>>() ? this : nullptr;
  }
  std::u16string dynamicToString() const override { return u"[object PromiseWithResolvers]"; }
  void Trace(cppgc::Visitor* visitor) const override { BaseObject::Trace(visitor); }
};

template <typename T>
PromiseResolvers<T>* promiseWithResolvers() {
  auto* result = Runtime::make<PromiseResolvers<T>>();
  result->promise = Task<T>::create([result](auto resolve, auto reject) {
    result->resolve = [resolve](T value) mutable { resolve(std::move(value)); };
    result->reject = [reject](Value reason) mutable { reject(std::move(reason)); };
  });
  return result;
}

template <typename T>
Task<ArrayObject<T>*> promiseAll(ArrayObject<Task<T>>* tasks) {
  cppgc::Persistent<ArrayObject<Task<T>>> rootedTasks(tasks);
  auto* values = Runtime::array<T>();
  cppgc::Persistent<ArrayObject<T>> rootedValues(values);
  for (auto task : *tasks) values->append(co_await task);
  co_return values;
}

template <typename T>
Task<T> promiseRace(ArrayObject<Task<T>>* tasks) {
  cppgc::Persistent<ArrayObject<Task<T>>> rootedTasks(tasks);
  return Task<T>::create([rootedTasks](auto resolve, auto reject) mutable {
    for (std::size_t index = 0; index < rootedTasks->size(); ++index) {
      Task<T> task = rootedTasks->get(index);
      task.whenSettled([task, resolve, reject]() mutable {
        try {
          resolve(task.settledValue());
        } catch (const RejectedValue& rejected) {
          reject(rejected.reason());
        } catch (const std::exception& error) {
          reject(Error(exceptionText(error)));
        }
      });
    }
  });
}

template <typename T>
Task<ArrayObject<RecordObject*>*> promiseAllSettled(
    ArrayObject<Task<T>>* tasks) {
  cppgc::Persistent<ArrayObject<Task<T>>> rootedTasks(tasks);
  cppgc::Persistent<ArrayObject<RecordObject*>> rootedResults(Runtime::array<RecordObject*>());
  return Task<ArrayObject<RecordObject*>*>::create(
      [rootedTasks, rootedResults](auto resolve, auto) mutable {
        const std::size_t count = rootedTasks->size();
        if (count == 0) {
          resolve(rootedResults.Get());
          return;
        }
        auto completed = std::make_shared<std::size_t>(0);
        for (std::size_t index = 0; index < count; ++index) {
          Task<T> task = rootedTasks->get(index);
          task.whenSettled([task, index, count, completed, rootedResults, resolve]() mutable {
            RecordObject* result = nullptr;
            try {
              result = Runtime::record({
                  {u"status", Runtime::string(u"fulfilled")},
                  {u"value", convertValue<Value>(task.settledValue())},
              });
            } catch (const RejectedValue& rejected) {
              result = Runtime::record({
                  {u"status", Runtime::string(u"rejected")},
                  {u"reason", rejected.reason()},
              });
            } catch (const std::exception& error) {
              result = Runtime::record({
                  {u"status", Runtime::string(u"rejected")},
                  {u"reason", Runtime::string(exceptionText(error))},
              });
            }
            rootedResults->set(index, result);
            *completed += 1;
            if (*completed == count) resolve(rootedResults.Get());
          });
        }
      });
}

template <typename T>
Task<T> promiseAny(ArrayObject<Task<T>>* tasks) {
  cppgc::Persistent<ArrayObject<Task<T>>> rootedTasks(tasks);
  return Task<T>::create([rootedTasks](auto resolve, auto reject) mutable {
    const std::size_t count = rootedTasks->size();
    if (count == 0) {
      reject(Error(std::u16string(u"All promises were rejected")));
      return;
    }
    auto rejected = std::make_shared<std::size_t>(0);
    for (std::size_t index = 0; index < count; ++index) {
      Task<T> task = rootedTasks->get(index);
      task.whenSettled([task, count, rejected, resolve, reject]() mutable {
        try {
          resolve(task.settledValue());
        } catch (...) {
          *rejected += 1;
          if (*rejected == count) reject(Error(std::u16string(u"All promises were rejected")));
        }
      });
    }
  });
}

template <typename T, typename Callback>
Task<typename PromiseResult<std::invoke_result_t<Callback, T>>::Type> promiseThen(
    Task<T> source,
    Callback callback) {
  using CallbackResult = std::invoke_result_t<Callback, T>;
  using Result = typename PromiseResult<CallbackResult>::Type;
  T value = co_await source;
  if constexpr (PromiseResult<CallbackResult>::task) {
    if constexpr (std::is_void_v<Result>) {
      co_await assimilateTask(callback(std::move(value)));
      co_return;
    } else {
      co_return co_await assimilateTask(callback(std::move(value)));
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
    Task<void> source,
    Callback callback) {
  using CallbackResult = std::invoke_result_t<Callback>;
  using Result = typename PromiseResult<CallbackResult>::Type;
  co_await source;
  if constexpr (PromiseResult<CallbackResult>::task) {
    if constexpr (std::is_void_v<Result>) {
      co_await assimilateTask(callback());
      co_return;
    } else {
      co_return co_await assimilateTask(callback());
    }
  } else if constexpr (std::is_void_v<CallbackResult>) {
    callback();
    co_return;
  } else {
    co_return callback();
  }
}

template <typename T, typename Callback>
Task<T> promiseCatch(Task<T> source, Callback callback) {
  Value reason = Value::undefined();
  try {
    co_return co_await source;
  } catch (const RejectedValue& rejected) {
    reason = rejected.reason();
  } catch (const std::exception& error) {
    reason = Runtime::string(exceptionText(error));
  }
  using CallbackResult = std::invoke_result_t<Callback, Value>;
  if constexpr (PromiseResult<CallbackResult>::task) {
    co_return co_await assimilateTask(callback(reason));
  } else {
    co_return callback(reason);
  }
}

template <typename T, typename Callback>
Task<T> promiseFinally(Task<T> source, Callback callback) {
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
