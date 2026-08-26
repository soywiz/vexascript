// VexaScript C++ runtime interface and template implementation. Native builds
// consume this through a reusable precompiled header and link the cached
// runtime.cpp static library.
#pragma once

#include <algorithm>
#include <atomic>
#include <bit>
#include <chrono>
#include <cctype>
#include <cmath>
#include <coroutine>
#include <cstring>
#include <cstdlib>
#include <cstdio>
#include <cstdint>
#include <ctime>
#include <deque>
#include <exception>
#include <functional>
#include <fstream>
#include <filesystem>
#include <future>
#include <iomanip>
#include <initializer_list>
#include <iostream>
#include <iterator>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <queue>
#include <regex>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <stdexcept>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <variant>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
#include <sys/wait.h>
#endif

#include "bigint.hpp"
#include "utf.hpp"

#include <cppgc/allocation.h>
#include <cppgc/garbage-collected.h>
#include <cppgc/heap.h>
#include <cppgc/member.h>
#include <cppgc/persistent.h>
#include <cppgc/platform.h>
#include <cppgc/visitor.h>
#include <src/base/page-allocator.h>


namespace vexa {

#include "platform.hpp"
#include "values.hpp"
#include "arrays.hpp"
#include "collection_equality.hpp"
#include "collections.hpp"
#include "uri.hpp"
#include "date.hpp"
#include "array_buffer.hpp"
#include "typed_arrays.hpp"
#include "data_view.hpp"
#include "iteration.hpp"
#include "object_helpers.hpp"
#include "errors.hpp"
#include "regexp.hpp"
#include "intl.hpp"
#include "strings_replace.hpp"
#include "runtime_state.hpp"
#include "runtime_factory.hpp"
#include "regexp_operations.hpp"
#include "strings_legacy.hpp"
#include "value_conversions.hpp"
#include "collections_algorithms.hpp"
#include "binary_data_algorithms.hpp"
#include "functions.hpp"
#include "object_grouping.hpp"
#include "objects.hpp"
#include "control_flow.hpp"
#include "tasks.hpp"
#include "native_io.hpp"
#include "generators.hpp"
#include "arrays_algorithms.hpp"
#include "conversions.hpp"
#include "promises.hpp"
#include "arrays_format.hpp"
#include "json.hpp"
#include "string_array_helpers.hpp"
#include "primitives.hpp"
#include "bigint_operations.hpp"
#include "numbers.hpp"
#include "strings.hpp"
#include "coercion.hpp"
#include "dynamic_arrays.hpp"
#include "operators.hpp"
#include "globals.hpp"
#include "math.hpp"
#include "console.hpp"

}  // namespace vexa
