#pragma once

// Internal runtime category header. Include runtime.hpp instead.

int uriHexValue(char16_t value);

std::u16string decodeUriComponentText(const std::u16string& value);

std::u16string encodeUriComponentText(const std::u16string& value);

class URLObject final : public cppgc::GarbageCollected<URLObject>, public BaseObject {
 public:
  explicit URLObject(std::u16string value);

  const void* dynamicTypeToken() const override;
  void* dynamicCast(const void* type) override;
  std::u16string dynamicToString() const override;
  void Trace(cppgc::Visitor* visitor) const override;

  std::u16string href;
  std::u16string protocol;
  std::u16string pathname;
};
