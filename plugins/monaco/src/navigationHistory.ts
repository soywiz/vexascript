export interface NavigationTarget {
  uri: string;
  lineNumber?: number;
  column?: number;
  endLineNumber?: number;
  endColumn?: number;
}

export interface NavigationHistoryState {
  backStack: NavigationTarget[];
  current: NavigationTarget | null;
  forwardStack: NavigationTarget[];
}

export function sameNavigationTarget(
  left: NavigationTarget | null,
  right: NavigationTarget | null
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.uri === right.uri &&
    left.lineNumber === right.lineNumber &&
    left.column === right.column &&
    left.endLineNumber === right.endLineNumber &&
    left.endColumn === right.endColumn
  );
}

export function pushNavigationTarget(
  state: NavigationHistoryState,
  target: NavigationTarget
): NavigationHistoryState {
  if (sameNavigationTarget(state.current, target)) {
    return state;
  }
  return {
    backStack: state.current ? [...state.backStack, state.current] : state.backStack,
    current: target,
    forwardStack: [],
  };
}

export function stepBack(state: NavigationHistoryState): NavigationHistoryState {
  if (state.backStack.length === 0 || !state.current) {
    return state;
  }
  const previous = state.backStack[state.backStack.length - 1]!;
  return {
    backStack: state.backStack.slice(0, -1),
    current: previous,
    forwardStack: [state.current, ...state.forwardStack],
  };
}

export function stepForward(state: NavigationHistoryState): NavigationHistoryState {
  if (state.forwardStack.length === 0 || !state.current) {
    return state;
  }
  const next = state.forwardStack[0]!;
  return {
    backStack: [...state.backStack, state.current],
    current: next,
    forwardStack: state.forwardStack.slice(1),
  };
}
