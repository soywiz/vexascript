#include "runtime.hpp"

namespace vexa {

const std::u16string& Error::messageText() const { return message_; }

const std::u16string& Error::nameText() const { return name_; }

std::u16string Error::stackText() const {
    return message_.empty() ? name_ : name_ + u": " + message_;
  }

const Value& Error::cause() const { return cause_; }

const Value& Error::errors() const { return errors_; }


Error::Error(
      const Value& value,
      std::u16string name,
      Value cause,
      Value errors)
      : message_(value.isUndefined() ? u"" : value.isString() ? value.string() : toString(value)),
        name_(std::move(name)),
        cause_(std::move(cause)),
        errors_(std::move(errors)) {}

Error::Error(std::u16string value)
      : message_(std::move(value)), name_(u"Error") {}
}  // namespace vexa
