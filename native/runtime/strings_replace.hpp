#pragma once

// Internal runtime category header. Include runtime.hpp instead.

bool regexTest(const RegExp& expression, const Value& value);

std::u16string stringReplace(const std::u16string& value, const RegExp& expression, const Value& replacement);

std::u16string stringReplace(const std::u16string& value, const RegExp& expression, const std::u16string& replacement);

std::u16string stringReplace(const std::u16string& value, const std::u16string& search, const std::u16string& replacement);

std::u16string stringReplace(const Value& value, const Value& search, const Value& replacement);

std::u16string stringReplace(const Value& value, const RegExp& expression, const Value& replacement);

std::u16string stringReplace(const Value& value, const RegExp& expression, const std::u16string& replacement);

std::u16string stringReplace(const std::u16string& value, const std::u16string& search, const Value& replacement);

std::u16string stringReplace(const Value& value, const std::u16string& search, const std::u16string& replacement);

std::u16string stringReplaceAll(
    const std::u16string& value,
    const std::u16string& search,
    const std::u16string& replacement);

std::u16string stringReplaceAll(
    const Value& value,
    const Value& search,
    const Value& replacement);

std::u16string stringReplaceAll(
    const std::u16string& value,
    const std::u16string& search,
    const Value& replacement);

bool stringIsWellFormed(const std::u16string& value);

bool stringIsWellFormed(const Value& value);

std::u16string stringToWellFormed(const std::u16string& value);

std::u16string stringToWellFormed(const Value& value);

std::u16string stringReplace(const Value& value, const std::u16string& search, const Value& replacement);
