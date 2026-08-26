#pragma once

// Internal runtime category header. Include runtime.hpp instead.

class Error {
 public:
  explicit Error(
      const Value& value,
      std::u16string name = u"Error",
      Value cause = Value::undefined(),
      Value errors = Value::undefined())
      : message_(value.isUndefined() ? u"" : value.isString() ? value.string() : toString(value)),
        name_(std::move(name)),
        cause_(std::move(cause)),
        errors_(std::move(errors)) {}
  explicit Error(std::u16string value)
      : message_(std::move(value)), name_(u"Error") {}

  const std::u16string& messageText() const { return message_; }
  const std::u16string& nameText() const { return name_; }
  std::u16string stackText() const {
    return message_.empty() ? name_ : name_ + u": " + message_;
  }
  const Value& cause() const { return cause_; }
  const Value& errors() const { return errors_; }

 private:
  std::u16string message_;
  std::u16string name_;
  Value cause_;
  Value errors_;
};
