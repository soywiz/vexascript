#pragma once

// Internal runtime category header. Include runtime.hpp instead.

template <typename T>
class DynamicArrayMethodObject final
    : public cppgc::GarbageCollected<DynamicArrayMethodObject<T>>,
      public BaseObject {
 public:
  DynamicArrayMethodObject(ArrayObject<T>* array, std::u16string method)
      : array_(array), method_(std::move(method)) {}

  const void* dynamicTypeToken() const override {
    return nativeTypeToken<DynamicArrayMethodObject<T>>();
  }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<DynamicArrayMethodObject<T>>() ? this : nullptr;
  }
  std::u16string dynamicToString() const override { return u"function"; }
  void Trace(cppgc::Visitor* visitor) const final {
    BaseObject::Trace(visitor);
    visitor->Trace(array_);
  }

  Value dynamicCall(const std::vector<Value>& arguments) override {
    if (!array_) throw Runtime::errorAtCurrentSource(u"Cannot call an array method on null");
    if constexpr (IsDynamicArrayElement<T>) {
      if (method_ == u"push") {
        for (const auto& argument : arguments) array_->append(convertValue<T>(argument));
        return Value(static_cast<double>(array_->size()));
      }
      if (method_ == u"unshift") {
        for (auto iterator = arguments.rbegin(); iterator != arguments.rend(); ++iterator) {
          array_->prepend(convertValue<T>(*iterator));
        }
        return Value(static_cast<double>(array_->size()));
      }
      if (method_ == u"pop") return convertValue<Value>(array_->pop());
      if (method_ == u"shift") return convertValue<Value>(array_->shift());
      if (method_ == u"reverse") {
        array_->reverse();
        return Value(static_cast<BaseObject*>(array_.Get()));
      }
      if (method_ == u"at") {
        const double index = arguments.empty() ? 0 : Number(arguments[0]);
        return convertValue<Value>(array_->at(index));
      }
      if (method_ == u"includes" || method_ == u"indexOf" || method_ == u"lastIndexOf") {
        const Value searched = arguments.empty() ? Value::undefined() : arguments[0];
        double found = -1;
        for (std::size_t index = 0; index < array_->size(); ++index) {
          if (!strictEquals(array_->dynamicArrayGet(index), searched)) continue;
          found = static_cast<double>(index);
          if (method_ != u"lastIndexOf") break;
        }
        return method_ == u"includes" ? Value(found >= 0) : Value(found);
      }
      if (method_ == u"join") {
        const std::u16string separator = arguments.empty() ? u"," : toString(arguments[0]);
        return Value(Runtime::string(array_->join(separator)));
      }
      if (method_ == u"slice") {
        const double start = arguments.empty() ? 0 : Number(arguments[0]);
        const double end = arguments.size() < 2
          ? std::numeric_limits<double>::infinity()
          : Number(arguments[1]);
        return Value(static_cast<BaseObject*>(array_->slice(start, end)));
      }
    }
    if (arguments.empty()) {
      throw Runtime::errorAtCurrentSource(u"Dynamic array callback method requires a callback");
    }
    const Value callback = arguments[0];
    const auto invoke = [&](std::size_t index, const Value* accumulator = nullptr) {
      const Value element = array_->dynamicArrayGet(index);
      std::vector<Value> callbackArguments;
      if (accumulator) callbackArguments.push_back(*accumulator);
      callbackArguments.push_back(element);
      callbackArguments.push_back(Value(static_cast<double>(index)));
      callbackArguments.push_back(Value(static_cast<BaseObject*>(array_.Get())));
      return call(callback, std::move(callbackArguments));
    };

    if (method_ == u"map") {
      auto* result = Runtime::array<Value>();
      for (std::size_t index = 0; index < array_->size(); ++index) result->append(invoke(index));
      return Value(static_cast<BaseObject*>(result));
    }
    if (method_ == u"filter") {
      auto* result = Runtime::array<Value>();
      for (std::size_t index = 0; index < array_->size(); ++index) {
        if (Boolean(invoke(index))) result->append(array_->dynamicArrayGet(index));
      }
      return Value(static_cast<BaseObject*>(result));
    }
    if (method_ == u"flatMap") {
      auto* result = Runtime::array<Value>();
      for (std::size_t index = 0; index < array_->size(); ++index) {
        const Value mapped = invoke(index);
        if (mapped.isRuntimeObject() && mapped.object()->dynamicIsArray()) {
          auto* nested = mapped.object();
          for (std::size_t nestedIndex = 0; nestedIndex < nested->dynamicArraySize(); ++nestedIndex) {
            result->append(nested->dynamicArrayGet(nestedIndex));
          }
        } else {
          result->append(mapped);
        }
      }
      return Value(static_cast<BaseObject*>(result));
    }
    if (method_ == u"some") {
      for (std::size_t index = 0; index < array_->size(); ++index) {
        if (Boolean(invoke(index))) return Value(true);
      }
      return Value(false);
    }
    if (method_ == u"every") {
      for (std::size_t index = 0; index < array_->size(); ++index) {
        if (!Boolean(invoke(index))) return Value(false);
      }
      return Value(true);
    }
    if (method_ == u"find") {
      for (std::size_t index = 0; index < array_->size(); ++index) {
        if (Boolean(invoke(index))) return array_->dynamicArrayGet(index);
      }
      return Value::undefined();
    }
    if (method_ == u"findIndex") {
      for (std::size_t index = 0; index < array_->size(); ++index) {
        if (Boolean(invoke(index))) return Value(static_cast<double>(index));
      }
      return Value(-1.0);
    }
    if (method_ == u"forEach") {
      for (std::size_t index = 0; index < array_->size(); ++index) invoke(index);
      return Value::undefined();
    }
    if (method_ == u"reduce") {
      std::size_t index = 0;
      Value accumulator;
      if (arguments.size() > 1) {
        accumulator = arguments[1];
      } else {
        if (array_->empty()) {
          throw Runtime::errorAtCurrentSource(u"Reduce of empty array with no initial value");
        }
        accumulator = array_->dynamicArrayGet(index++);
      }
      for (; index < array_->size(); ++index) accumulator = invoke(index, &accumulator);
      return accumulator;
    }
    throw Runtime::errorAtCurrentSource(u"Unsupported dynamic array method");
  }

 private:
  cppgc::Member<ArrayObject<T>> array_;
  std::u16string method_;
};

template <typename T>
inline Value ArrayObject<T>::dynamicGet(const std::u16string& key) {
    if (key == u"length") return Value(static_cast<double>(size()));
  if (
    key == u"map" || key == u"filter" || key == u"flatMap" ||
    key == u"some" || key == u"every" || key == u"find" ||
    key == u"findIndex" || key == u"forEach" || key == u"reduce" ||
    key == u"push" || key == u"pop" || key == u"shift" ||
    key == u"unshift" || key == u"reverse" || key == u"at" ||
    key == u"includes" || key == u"indexOf" || key == u"lastIndexOf" ||
    key == u"join" || key == u"slice"
  ) {
    return Value(static_cast<BaseObject*>(
      Runtime::make<DynamicArrayMethodObject<T>>(this, key)
    ));
  }
  if constexpr (IsDynamicArrayElement<T>) {
    if (const auto index = propertyIndex(key); index && *index < size()) {
      if constexpr (std::is_pointer_v<T> && std::is_base_of_v<EnumerableObject, std::remove_pointer_t<T>>) {
        auto* value = get(*index);
        return value && value->enumerableBackingRecord()
          ? Value(value->enumerableBackingRecord())
          : Value::undefined();
      } else {
        return convertValue<Value>(get(*index));
      }
    }
    return BaseObject::dynamicGet(key);
  } else {
    throw Runtime::errorAtCurrentSource(
      std::u16string(u"This native array element type cannot flow through dynamic access: ") +
      utf8ToUtf16(__PRETTY_FUNCTION__)
    );
  }
}

template <typename T>
inline bool Boolean(T* value) {
  return value != nullptr;
}

template <typename T>
inline bool Boolean(const std::vector<T>&) {
  return true;
}
