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

  static void initialize(std::size_t suggestedInitialHeapSizeBytes = 0);

  static void shutdown();

  static Value string(std::u16string value);

  static Value concatStrings(StringObject* left, StringObject* right);

  static StringObject* retainLiteralString(std::u16string value);

  static void reserveLiterals(std::size_t count);

  static RecordObject* record(
      std::initializer_list<std::pair<std::u16string, Value>> properties = {});

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

  static cppgc::Heap& heap();

  static void setSourceLocation(std::u16string file, std::size_t line, std::size_t column);

  static std::u16string sourceLocation();

  static std::runtime_error errorAtCurrentSource(std::u16string message);

  static void collectGarbageIfStressed();

  static TimerId setTimeout(TimerCallback callback, double delay = 0);

  static TimerId setInterval(TimerCallback callback, double delay = 0);

  static void clearTimeout(TimerId id);
  static void clearInterval(TimerId id);
  static void clearTimeout(const Value& id);
  static void clearInterval(const Value& id);

  static void runEventLoop();

  static void enqueueMicrotask(TimerCallback callback);

  static void enqueueIo(IoPoller poller);

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
    bool operator()(const ScheduledTimer& left, const ScheduledTimer& right) const;
  };

  static Clock::time_point deadline(double delay);

  static TimerId scheduleTimer(TimerCallback callback, double delay, bool repeating);

  static bool runOneEvent();

  static std::shared_ptr<OilpanPlatform> platform_;
  static std::unique_ptr<cppgc::Heap> heap_;
  static std::u16string sourceFile_;
  static std::size_t sourceLine_;
  static std::size_t sourceColumn_;
  static std::size_t statementsUntilCollection_;
  static TimerId nextTimerId_;
  static std::deque<TimerCallback> microtasks_;
  static std::vector<IoPoller> ioPollers_;
  static std::vector<cppgc::Persistent<StringObject>> literalStrings_;
  static std::unordered_map<TimerId, TimerState> timers_;
  static std::priority_queue<ScheduledTimer, std::vector<ScheduledTimer>, EarlierTimer> scheduledTimers_;
};
