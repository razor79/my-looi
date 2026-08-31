let mainScreenFocused = false;
const focusListeners = new Set<(focused: boolean) => void>();

/**
 * Route focus is deliberately separate from React Native AppState. Settings is
 * an in-app route, not Android background. A system share sheet may background
 * the process while Settings remains the focused route.
 */
export function setMainScreenFocused(focused: boolean): void {
  if (mainScreenFocused === focused) return;
  mainScreenFocused = focused;
  for (const listener of focusListeners) listener(focused);
}

export function isMainScreenFocused(): boolean {
  return mainScreenFocused;
}

export function subscribeMainScreenFocused(listener: (focused: boolean) => void): () => void {
  focusListeners.add(listener);
  return () => focusListeners.delete(listener);
}
