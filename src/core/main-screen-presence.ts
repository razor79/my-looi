let mainScreenFocused = false;

/**
 * Route focus is deliberately separate from React Native AppState. Settings is
 * an in-app route, not Android background. A system share sheet may background
 * the process while Settings remains the focused route.
 */
export function setMainScreenFocused(focused: boolean): void {
  mainScreenFocused = focused;
}

export function isMainScreenFocused(): boolean {
  return mainScreenFocused;
}
