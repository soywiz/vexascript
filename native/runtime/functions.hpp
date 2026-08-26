#pragma once

// Internal runtime category header. Include runtime.hpp instead.

template <typename Result, typename... Arguments>
class FunctionObject final
    : public cppgc::GarbageCollected<FunctionObject<Result, Arguments...>>,
      public BaseObject {
 public:
  template <typename Callback>
  explicit FunctionObject(Callback callback, std::initializer_list<Value> roots = {})
      : callback_(std::move(callback)) {
    roots_.reserve(roots.size());
    for (const auto& root : roots) roots_.emplace_back(root);
  }

  Result invoke(Arguments... arguments) {
    return callback_(std::forward<Arguments>(arguments)...);
  }

  const void* dynamicTypeToken() const override {
    return nativeTypeToken<FunctionObject<Result, Arguments...>>();
  }

  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<FunctionObject<Result, Arguments...>>() ? this : nullptr;
  }

  std::u16string dynamicToString() const override { return u"function"; }

  Value dynamicCall(const std::vector<Value>& arguments) override {
    if (arguments.size() >= sizeof...(Arguments)) {
      return dynamicCallWithIndices(arguments, std::index_sequence_for<Arguments...>{});
    }
    auto normalizedArguments = arguments;
    normalizedArguments.resize(sizeof...(Arguments), Value::undefined());
    return dynamicCallWithIndices(normalizedArguments, std::index_sequence_for<Arguments...>{});
  }

  void Trace(cppgc::Visitor* visitor) const override {
    BaseObject::Trace(visitor);
    for (const auto& root : roots_) root.Trace(visitor);
  }

 private:
  template <std::size_t... Indices>
  Value dynamicCallWithIndices(
      const std::vector<Value>& arguments,
      std::index_sequence<Indices...>) {
    if constexpr (std::is_void_v<Result>) {
      callback_(convertValue<Arguments>(arguments[Indices])...);
      return Value::undefined();
    } else if constexpr (TaskTraits<Result>::value) {
      auto task = callback_(convertValue<Arguments>(arguments[Indices])...);
      if constexpr (std::is_void_v<typename TaskTraits<Result>::Result>) {
        task.get();
        return Value::undefined();
      } else {
        return convertValue<Value>(task.get());
      }
    } else {
      return convertValue<Value>(
          callback_(convertValue<Arguments>(arguments[Indices])...));
    }
  }

  std::function<Result(Arguments...)> callback_;
  std::vector<StoredValue> roots_;
};

template <typename Function>
struct FunctionFromValue;

template <typename Result, typename... Arguments>
struct FunctionFromValue<std::function<Result(Arguments...)>> {
  static std::function<Result(Arguments...)> convert(const Value& value) {
    if (value.isUndefined() || value.isNull()) return {};
    if (!value.isRuntimeObject()) throw errorAtCurrentSource(u"VexaScript value is not callable");
    auto* function = static_cast<FunctionObject<Result, Arguments...>*>(
        value.object()->dynamicCast(nativeTypeToken<FunctionObject<Result, Arguments...>>()));
    if (!function) throw errorAtCurrentSource(u"VexaScript callable has an incompatible native signature");
    cppgc::Persistent<FunctionObject<Result, Arguments...>> rooted(function);
    return [rooted = std::move(rooted)](Arguments... arguments) mutable -> Result {
      return rooted->invoke(std::forward<Arguments>(arguments)...);
    };
  }
};

template <typename Result>
Result functionFromValue(const Value& value) {
  return FunctionFromValue<Result>::convert(value);
}

template <typename Result, typename... Arguments, typename Callback>
FunctionObject<Result, Arguments...>* makeFunction(
    Callback callback,
    std::initializer_list<Value> roots = {}) {
  return Runtime::make<FunctionObject<Result, Arguments...>>(std::move(callback), roots);
}

template <typename Result, typename... Arguments>
inline Value toValue(const std::function<Result(Arguments...)>& callback) {
  return Value(makeFunction<Result, Arguments...>(callback));
}

inline Value call(const Value& callable, std::vector<Value> arguments) {
  if (!callable.isRuntimeObject()) {
    throw errorAtCurrentSource(u"VexaScript value is not callable");
  }
  return callable.object()->dynamicCall(arguments);
}

inline Value callOptional(const Value& callable, std::vector<Value> arguments) {
  if (callable.isNull() || callable.isUndefined()) return Value::undefined();
  return call(callable, std::move(arguments));
}

template <typename Result>
Result recordGet(RecordObject* record, const std::u16string& key) {
  if (!record) throw runtimeError(u"Cannot read a property of null");
  return convertValue<Result>(record->get(key));
}

template <typename Result>
Result recordGet(const Value& value, const std::u16string& key) {
  if (!value.isRecord()) throw runtimeError(u"Cannot read a property of a non-record value");
  return recordGet<Result>(value.record(), key);
}

template <typename Input>
std::remove_cvref_t<Input> recordSet(
    RecordObject* record,
    const std::u16string& key,
    Input&& input) {
  if (!record) throw runtimeError(u"Cannot write a property of null");
  using Result = std::remove_cvref_t<Input>;
  Result result = std::forward<Input>(input);
  record->set(key, convertValue<Value>(result));
  return result;
}
