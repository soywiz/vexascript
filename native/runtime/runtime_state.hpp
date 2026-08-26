#pragma once

// Internal runtime category header. Include runtime.hpp instead.

template <typename Callback>
class Finally final {
 public:
  explicit Finally(Callback callback) : callback_(std::move(callback)) {}
  Finally(const Finally&) = delete;
  Finally& operator=(const Finally&) = delete;

  Finally(Finally&& other) noexcept
      : callback_(std::move(other.callback_)), active_(std::exchange(other.active_, false)) {}

  ~Finally() noexcept(false) {
    if (active_) callback_();
  }

 private:
  Callback callback_;
  bool active_ = true;
};

template <typename Callback>
Finally<std::decay_t<Callback>> finally(Callback&& callback) {
  return Finally<std::decay_t<Callback>>(std::forward<Callback>(callback));
}

class Runtime final {
 public:
  using TimerId = std::int32_t;
  using TimerCallback = std::function<void()>;
  using IoPoller = std::function<bool()>;

  static void initialize(std::size_t suggestedInitialHeapSizeBytes = 0) {
    if (heap_) return;
    platform_ = std::make_shared<OilpanPlatform>();
    cppgc::InitializeProcess(platform_->GetPageAllocator());
    cppgc::Heap::HeapOptions options;
    options.marking_support = cppgc::Heap::MarkingType::kAtomic;
    options.sweeping_support = cppgc::Heap::SweepingType::kAtomic;
    options.stack_support = cppgc::Heap::StackSupport::kSupportsConservativeStackScan;
    options.stack_start_marker.emplace();
    if (const auto configuredInitialHeapSize = initialHeapSizeBytes()) {
      options.resource_constraints.initial_heap_size_bytes = *configuredInitialHeapSize;
    } else if (suggestedInitialHeapSizeBytes > 0) {
      options.resource_constraints.initial_heap_size_bytes = suggestedInitialHeapSizeBytes;
    }
    heap_ = cppgc::Heap::Create(platform_, std::move(options));
  }

  static void shutdown() {
    timers_.clear();
    while (!scheduledTimers_.empty()) scheduledTimers_.pop();
    microtasks_.clear();
    ioPollers_.clear();
    literalStrings_.clear();
    heap_.reset();
    cppgc::ShutdownProcess();
    platform_.reset();
  }

  static Value string(std::u16string value) {
    initialize();
    return Value(cppgc::MakeGarbageCollected<StringObject>(
        heap_->GetAllocationHandle(), std::move(value)));
  }

  static Value concatStrings(StringObject* left, StringObject* right) {
    initialize();
    if (left->size() == 0) return Value(right);
    if (right->size() == 0) return Value(left);
    return Value(cppgc::MakeGarbageCollected<StringObject>(
        heap_->GetAllocationHandle(), left, right));
  }

  static StringObject* retainLiteralString(std::u16string value) {
    initialize();
    auto* literal = cppgc::MakeGarbageCollected<StringObject>(
        heap_->GetAllocationHandle(), std::move(value));
    literalStrings_.emplace_back(literal);
    return literal;
  }

  static void reserveLiterals(std::size_t count) { literalStrings_.reserve(count); }

  static RecordObject* record(
      std::initializer_list<std::pair<std::u16string, Value>> properties = {}) {
    auto* result = make<RecordObject>();
    for (const auto& [key, value] : properties) result->set(key, value);
    return result;
  }

  template <typename T>
  static ArrayObject<T>* array(std::initializer_list<T> values = {}) {
    return make<ArrayObject<T>>(values);
  }

  template <typename T, typename... Arguments>
  static T* make(Arguments&&... arguments) {
    initialize();
    return cppgc::MakeGarbageCollected<T>(
        heap_->GetAllocationHandle(), std::forward<Arguments>(arguments)...);
  }

  static cppgc::Heap& heap() {
    initialize();
    return *heap_;
  }

  static void setSourceLocation(std::u16string file, std::size_t line, std::size_t column) {
    sourceFile_ = std::move(file);
    sourceLine_ = line;
    sourceColumn_ = column;
  }

  static std::u16string sourceLocation() {
    if (sourceFile_.empty()) return u"";
    return sourceFile_ + u":" + formatIntegerText(sourceLine_) +
        u":" + formatIntegerText(sourceColumn_);
  }

  static std::runtime_error errorAtCurrentSource(std::u16string message) {
    const auto location = sourceLocation();
    if (!location.empty()) message += u" at " + location;
    return runtimeError(message);
  }

  static void collectGarbageIfStressed() {
#if defined(VEXA_NATIVE_GC_STRESS)
    if (++statementsUntilCollection_ >= 8) {
      statementsUntilCollection_ = 0;
      heap_->ForceGarbageCollectionSlow(
          "VexaScript native statement", "VEXA_NATIVE_GC_STRESS",
          cppgc::Heap::StackState::kMayContainHeapPointers);
    }
#endif
  }

  static TimerId setTimeout(TimerCallback callback, double delay = 0) {
    return scheduleTimer(std::move(callback), delay, false);
  }

  static TimerId setInterval(TimerCallback callback, double delay = 0) {
    return scheduleTimer(std::move(callback), delay, true);
  }

  static void clearTimeout(TimerId id) { timers_.erase(id); }
  static void clearInterval(TimerId id) { timers_.erase(id); }
  static void clearTimeout(const Value& id) { clearTimeout(static_cast<TimerId>(Number(id))); }
  static void clearInterval(const Value& id) { clearInterval(static_cast<TimerId>(Number(id))); }

  static void runEventLoop() {
    while (runOneEvent()) {}
  }

  static void enqueueMicrotask(TimerCallback callback) {
    microtasks_.push_back(std::move(callback));
  }

  static void enqueueIo(IoPoller poller) {
    ioPollers_.push_back(std::move(poller));
  }

  template <typename Predicate>
  static void runUntil(Predicate settled) {
    while (!settled()) {
      if (!runOneEvent()) {
        throw runtimeError(u"VexaScript task cannot settle because the event loop is empty");
      }
    }
  }

 private:
  using Clock = std::chrono::steady_clock;

  struct TimerState final {
    TimerCallback callback;
    double delay;
    bool repeating;
  };

  struct ScheduledTimer final {
    Clock::time_point due;
    TimerId id;
  };

  struct EarlierTimer final {
    bool operator()(const ScheduledTimer& left, const ScheduledTimer& right) const {
      if (left.due != right.due) return left.due > right.due;
      return left.id > right.id;
    }
  };

  static Clock::time_point deadline(double delay) {
    const auto milliseconds = std::chrono::duration<double, std::milli>(std::max(0.0, delay));
    return Clock::now() + std::chrono::duration_cast<Clock::duration>(milliseconds);
  }

  static TimerId scheduleTimer(TimerCallback callback, double delay, bool repeating) {
    const TimerId id = nextTimerId_++;
    timers_.emplace(id, TimerState{std::move(callback), delay, repeating});
    scheduledTimers_.push({deadline(delay), id});
    return id;
  }

  static bool runOneEvent() {
    if (!microtasks_.empty()) {
      TimerCallback callback = std::move(microtasks_.front());
      microtasks_.pop_front();
      callback();
      return true;
    }

    for (auto poller = ioPollers_.begin(); poller != ioPollers_.end(); ++poller) {
      if (!(*poller)()) continue;
      ioPollers_.erase(poller);
      return true;
    }

    while (!scheduledTimers_.empty()) {
      const ScheduledTimer scheduled = scheduledTimers_.top();
      scheduledTimers_.pop();
      auto timer = timers_.find(scheduled.id);
      if (timer == timers_.end()) continue;

      const auto now = Clock::now();
      if (scheduled.due > now && !ioPollers_.empty()) {
        scheduledTimers_.push(scheduled);
        std::this_thread::sleep_for(std::min(
            std::chrono::milliseconds(1),
            std::chrono::duration_cast<std::chrono::milliseconds>(scheduled.due - now)));
        return true;
      }
      if (scheduled.due > now) std::this_thread::sleep_until(scheduled.due);

      TimerCallback callback = timer->second.callback;
      const bool repeating = timer->second.repeating;
      if (!repeating) timers_.erase(timer);
      callback();

      timer = timers_.find(scheduled.id);
      if (repeating && timer != timers_.end()) {
        scheduledTimers_.push({deadline(timer->second.delay), scheduled.id});
      }
      return true;
    }
    if (!ioPollers_.empty()) {
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
      return true;
    }
    return false;
  }

  inline static std::shared_ptr<OilpanPlatform> platform_;
  inline static std::unique_ptr<cppgc::Heap> heap_;
  inline static std::u16string sourceFile_;
  inline static std::size_t sourceLine_ = 0;
  inline static std::size_t sourceColumn_ = 0;
  inline static std::size_t statementsUntilCollection_ = 0;
  inline static TimerId nextTimerId_ = 1;
  inline static std::deque<TimerCallback> microtasks_;
  inline static std::vector<IoPoller> ioPollers_;
  inline static std::vector<cppgc::Persistent<StringObject>> literalStrings_;
  inline static std::unordered_map<TimerId, TimerState> timers_;
  inline static std::priority_queue<ScheduledTimer, std::vector<ScheduledTimer>, EarlierTimer> scheduledTimers_;
};
