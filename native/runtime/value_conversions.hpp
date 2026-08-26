#pragma once

// Internal runtime category header. Include runtime.hpp instead.

template <typename T>
concept RecordAdaptable = requires(RecordObject* record) {
  { T::fromRecord(record) } -> std::convertible_to<T*>;
};

template <typename T>
concept DynamicObjectView = requires(BaseObject* object) {
  { T::fromDynamicObject(object) } -> std::convertible_to<T*>;
};

const std::u16string& toText(const std::u16string& value);
std::u16string toText(std::u16string&& value);
std::u16string toText(const Value& value);

bool toBoolean(bool value);
bool toBoolean(Undefined);
bool toBoolean(double value);
bool toBoolean(std::int32_t value);
bool toBoolean(const Value& value);

double toDouble(double value);
double toDouble(std::int32_t value);
double toDouble(bool value);
double toDouble(const Value& value);

std::int32_t toNativeInt32(std::int32_t value);
std::int32_t toNativeInt32(double value);
std::int32_t toNativeInt32(bool value);
std::int32_t toNativeInt32(const Value& value);

BigInt toBigInt(const BigInt& value);
BigInt toBigInt(BigInt&& value);
BigInt toBigInt(const Value& value);

Undefined toUndefined(Undefined value);
Undefined toUndefined(const Value& value);

Null toNull(Null value);
Null toNull(const Value& value);

Error toError(Error value);

template <typename Result, typename Input>
  requires IsStdFunction<Result>::value
Result toFunction(Input&& input) {
  using Source = std::remove_cvref_t<Input>;
  if constexpr (std::is_same_v<Result, Source>) {
    return std::forward<Input>(input);
  } else if constexpr (std::is_same_v<Source, Value>) {
    return functionFromValue<Result>(input);
  } else {
    return Result(std::forward<Input>(input));
  }
}

template <typename Result>
Result Value::toInstance() const {
  static_assert(std::is_pointer_v<Result>);
  if (isNull() || isUndefined()) return nullptr;
  if constexpr (std::is_same_v<Result, cppgc::GarbageCollectedMixin*>) {
    if (isRecord()) return record();
    if (isRuntimeObject()) return object();
    throw errorAtCurrentSource(u"VexaScript WeakMap/WeakSet key is not an object");
  } else if constexpr (RecordAdaptable<std::remove_pointer_t<Result>>) {
    if (isRuntimeObject()) {
      void* converted = object()->dynamicCast(nativeTypeToken<std::remove_pointer_t<Result>>());
      if (converted) return static_cast<Result>(converted);
      return std::remove_pointer_t<Result>::fromRecord(
          Runtime::make<RecordObject>(object()));
    }
    if (isRecord()) return std::remove_pointer_t<Result>::fromRecord(record());
    throw errorAtCurrentSource(u"VexaScript value is not a compatible structural object");
  } else {
    if (!isObject()) {
      throw errorAtCurrentSource(
          std::u16string(u"VexaScript dynamic value has an incompatible native object type: ") +
          utf8ToUtf16(__PRETTY_FUNCTION__) + u"; actual value: " + toString(*this));
    }
    void* converted = object()->dynamicCast(nativeTypeToken<std::remove_pointer_t<Result>>());
    if (!converted) {
      if constexpr (DynamicObjectView<std::remove_pointer_t<Result>>) {
        return std::remove_pointer_t<Result>::fromDynamicObject(object());
      }
    }
    if (!converted) {
      const auto kind = object()->dynamicGet(u"kind");
      throw errorAtCurrentSource(
          std::u16string(u"VexaScript dynamic value has an incompatible native object type: ") +
          utf8ToUtf16(__PRETTY_FUNCTION__) + u"; actual value: " + toString(*this) +
          (kind.isUndefined() ? u"" : u"; kind: " + toString(kind)));
    }
    return static_cast<Result>(converted);
  }
}

template <typename Result, typename Input>
  requires std::is_pointer_v<Result>
Result toInstance(Input&& input) {
  using Source = std::remove_cvref_t<Input>;
  if constexpr (std::is_same_v<Source, StoredValue>) {
    return toInstance<Result>(input.load());
  } else if constexpr (std::is_same_v<Result, Source>) {
    return std::forward<Input>(input);
  } else if constexpr (requires(Source value) { value.Get(); }) {
    return toInstance<Result>(input.Get());
  } else if constexpr (OptionalTraits<Source>::value) {
    return input ? toInstance<Result>(*input) : nullptr;
  } else if constexpr (
      std::is_same_v<Source, Null> ||
      std::is_same_v<Source, Undefined> ||
      std::is_same_v<Source, std::nullptr_t>) {
    return nullptr;
  } else if constexpr (std::is_same_v<Source, Value>) {
    return input.template toInstance<Result>();
  } else if constexpr (
      std::is_same_v<Source, RecordObject*> &&
      RecordAdaptable<std::remove_pointer_t<Result>>) {
    return std::remove_pointer_t<Result>::fromRecord(input);
  } else if constexpr (std::is_pointer_v<Source>) {
    if (!input) return nullptr;
    if constexpr (std::is_convertible_v<Source, Result>) {
      return static_cast<Result>(input);
    } else if constexpr (
        std::is_base_of_v<BaseObject, std::remove_pointer_t<Source>> &&
        std::is_base_of_v<BaseObject, std::remove_pointer_t<Result>>) {
      void* converted = input->dynamicCast(nativeTypeToken<std::remove_pointer_t<Result>>());
      if (!converted) {
        if constexpr (DynamicObjectView<std::remove_pointer_t<Result>>) {
          return std::remove_pointer_t<Result>::fromDynamicObject(static_cast<BaseObject*>(input));
        }
        throw errorAtCurrentSource(
            std::u16string(u"VexaScript object has an incompatible native pointer type (dynamic cast): ") +
            utf8ToUtf16(__PRETTY_FUNCTION__));
      }
      return static_cast<Result>(converted);
    } else if constexpr (
        std::is_base_of_v<EnumerableObject, std::remove_pointer_t<Source>> &&
        std::is_base_of_v<EnumerableObject, std::remove_pointer_t<Result>>) {
      void* converted = input->nativeInterfaceCast(nativeTypeToken<std::remove_pointer_t<Result>>());
      if (!converted) throw runtimeError(u"VexaScript object has an incompatible interface type");
      return static_cast<Result>(converted);
    } else if constexpr (
        std::is_same_v<Result, RecordObject*> &&
        std::is_base_of_v<EnumerableObject, std::remove_pointer_t<Source>>) {
      return input->enumerableBackingRecord();
    } else {
      throw errorAtCurrentSource(u"VexaScript object has an incompatible native pointer type (unsupported conversion)");
    }
  } else {
    throw errorAtCurrentSource(u"VexaScript value cannot be converted to a native object");
  }
}

template <typename Result>
  requires std::is_pointer_v<Result>
Result toInstanceOrNull(const Value& input) {
  if (!input.isRuntimeObject()) return nullptr;
  void* converted = input.object()->dynamicCast(nativeTypeToken<std::remove_pointer_t<Result>>());
  return converted ? static_cast<Result>(converted) : nullptr;
}

template <typename Result, typename Source>
  requires std::is_pointer_v<Result>
Result toInstanceOrNull(Source* input) {
  if (!input) return nullptr;
  if constexpr (std::is_convertible_v<Source*, Result>) {
    return static_cast<Result>(input);
  } else if constexpr (
      std::is_base_of_v<BaseObject, Source> &&
      std::is_base_of_v<BaseObject, std::remove_pointer_t<Result>>) {
    void* converted = input->dynamicCast(nativeTypeToken<std::remove_pointer_t<Result>>());
    return converted ? static_cast<Result>(converted) : nullptr;
  } else if constexpr (
      std::is_base_of_v<EnumerableObject, Source> &&
      std::is_base_of_v<EnumerableObject, std::remove_pointer_t<Result>>) {
    void* converted = input->nativeInterfaceCast(nativeTypeToken<std::remove_pointer_t<Result>>());
    return converted ? static_cast<Result>(converted) : nullptr;
  } else if constexpr (
      std::is_same_v<Result, RecordObject*> &&
      std::is_base_of_v<EnumerableObject, Source>) {
    return input->enumerableBackingRecord();
  } else {
    return nullptr;
  }
}

template <typename Result, typename T>
  requires std::is_pointer_v<Result>
Result toInstanceOrNull(const cppgc::Member<T>& input) {
  return toInstanceOrNull<Result>(input.Get());
}

template <typename Result, typename T>
  requires std::is_pointer_v<Result>
Result toInstanceOrNull(const cppgc::Persistent<T>& input) {
  return toInstanceOrNull<Result>(input.Get());
}

template <typename Result, typename Input>
Result convertValue(Input&& input) {
  using Source = std::remove_cvref_t<Input>;
  if constexpr (std::is_same_v<Source, StoredValue>) {
    return convertValue<Result>(input.load());
  } else if constexpr (std::is_same_v<Result, Source>) {
    return std::forward<Input>(input);
  } else if constexpr (requires(Source value) { value.Get(); }) {
    return convertValue<Result>(input.Get());
  } else if constexpr (OptionalTraits<Source>::value) {
    if (!input.has_value()) {
      if constexpr (std::is_same_v<Result, Value>) return Value::undefined();
      else return defaultValue<Result>();
    }
    return convertValue<Result>(*input);
  } else if constexpr (std::is_pointer_v<Result>) {
    return toInstance<Result>(std::forward<Input>(input));
  } else if constexpr (std::is_same_v<Result, Value>) {
    if constexpr (std::is_same_v<Source, Undefined>) {
      return Value::undefined();
    } else if constexpr (
        std::is_same_v<Source, Null> ||
        std::is_same_v<Source, std::nullptr_t>) {
      return Value::null();
    } else if constexpr (std::is_same_v<Source, std::u16string>) {
      return Runtime::string(std::forward<Input>(input));
    } else if constexpr (std::is_pointer_v<Source>) {
      if (!input) return Value::null();
      if constexpr (std::is_base_of_v<BaseObject, std::remove_pointer_t<Source>>) {
        return Value(static_cast<BaseObject*>(input));
      } else if constexpr (std::is_base_of_v<EnumerableObject, std::remove_pointer_t<Source>>) {
        auto* enumerable = static_cast<EnumerableObject*>(input);
        auto* record = enumerable->enumerableBackingRecord();
        if (!record) {
                    record = Runtime::record();
          for (const auto& key : enumerable->enumerableKeys()) {
            record->set(key, enumerable->enumerableGet(key));
          }
        }
        return Value(record);
      } else {
        return Value(std::forward<Input>(input));
      }
    } else {
      return Value(std::forward<Input>(input));
    }
  } else if constexpr (std::is_same_v<Source, Value>) {
    if constexpr (std::is_same_v<Result, Undefined>) {
      if (!input.isUndefined()) throw runtimeError(u"VexaScript value is not undefined");
      return Undefined{};
    } else if constexpr (std::is_same_v<Result, Null>) {
      if (!input.isNull()) throw errorAtCurrentSource(u"VexaScript value is not null");
      return Null{};
    } else if constexpr (std::is_same_v<Result, bool>) {
      return toBoolean(input);
    } else if constexpr (std::is_same_v<Result, BigInt>) {
      return toBigInt(input);
    } else if constexpr (std::is_same_v<Result, std::u16string>) {
      return toText(input);
    } else if constexpr (std::is_same_v<Result, double>) {
      return toDouble(input);
    } else if constexpr (std::is_same_v<Result, std::int32_t>) {
      return toNativeInt32(input);
    } else if constexpr (std::is_arithmetic_v<Result>) {
      return static_cast<Result>(toDouble(input));
    } else if constexpr (IsStdFunction<Result>::value) {
      return functionFromValue<Result>(input);
    } else {
      return std::forward<Input>(input);
    }
  } else {
    return std::forward<Input>(input);
  }
}

Value toValue(Value value);
Value toValue(const StoredValue& value);
Value toValue(Undefined);
Value toValue(Null);
Value toValue(std::nullptr_t);
Value toValue(bool value);
Value toValue(double value);
Value toValue(float value);
Value toValue(std::int32_t value);
Value toValue(std::uint32_t value);
Value toValue(std::int64_t value);
Value toValue(std::uint64_t value);
Value toValue(BigInt value);
Value toValue(const std::u16string& value);
Value toValue(std::u16string&& value);

template <typename T>
  requires std::is_enum_v<T>
inline Value toValue(T value) {
  return Value(static_cast<double>(value));
}

template <typename T>
  requires std::is_base_of_v<BaseObject, T>
inline Value toValue(T* value) {
  return value ? Value(static_cast<BaseObject*>(value)) : Value::null();
}

template <typename T>
inline Value toValue(T* value) {
  return convertValue<Value>(value);
}

template <typename T>
  requires requires(const T& value) { value.Get(); }
inline Value toValue(const T& value) {
  return toValue(value.Get());
}

template <typename T>
inline Value toValue(const std::optional<T>& value) {
  return value ? toValue(*value) : Value::undefined();
}

template <typename Interface, typename Adapter, typename Input>
inline Interface* adaptInterface(Input&& input) {
    using Source = std::remove_cvref_t<Input>;
  if constexpr (std::is_same_v<Source, Value>) {
    if (input.isRecord()) return Runtime::make<Adapter>(input.record());
    if (input.isRuntimeObject()) {
      void* converted = input.object()->dynamicCast(nativeTypeToken<Interface>());
      if (converted) return static_cast<Interface*>(converted);
      return Runtime::make<Adapter>(Runtime::make<RecordObject>(input.object()));
    }
    return convertValue<Interface*>(std::forward<Input>(input));
  } else if constexpr (std::is_same_v<Source, RecordObject*>) {
    return Runtime::make<Adapter>(input);
  } else if constexpr (std::is_pointer_v<Source> && std::is_convertible_v<Source, Interface*>) {
    return static_cast<Interface*>(input);
  } else if constexpr (
      std::is_pointer_v<Source> &&
      std::is_base_of_v<BaseObject, std::remove_pointer_t<Source>>) {
    if (!input) return nullptr;
    void* converted = input->dynamicCast(nativeTypeToken<Interface>());
    if (converted) return static_cast<Interface*>(converted);
    return Runtime::make<Adapter>(Runtime::make<RecordObject>(input));
  } else if constexpr (
      std::is_pointer_v<Source> &&
      std::is_base_of_v<EnumerableObject, std::remove_pointer_t<Source>>) {
    if (!input) return nullptr;
    auto* enumerable = static_cast<EnumerableObject*>(input);
    auto* record = enumerable->enumerableBackingRecord();
    if (!record) {
      record = Runtime::record();
      for (const auto& key : enumerable->enumerableKeys()) {
        record->set(key, enumerable->enumerableGet(key));
      }
    }
    return Runtime::make<Adapter>(record);
  } else {
    return convertValue<Interface*>(std::forward<Input>(input));
  }
}
