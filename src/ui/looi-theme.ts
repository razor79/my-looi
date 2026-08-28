export const looiTheme = {
  bg: "#03070d",
  bgRaised: "#07111d",
  surface: "rgba(8, 18, 30, 0.72)",
  surfaceStrong: "rgba(12, 30, 48, 0.86)",
  line: "rgba(84, 167, 255, 0.22)",
  lineActive: "rgba(40, 213, 255, 0.72)",
  text: "#edf7ff",
  muted: "#8c9bad",
  cyan: "#28d5ff",
  blue: "#1f7cff",
  ok: "#4de7b4",
  warn: "#ffd166",
  danger: "#ff5c7a",
  rail: "rgba(4, 12, 21, 0.9)",
  blackGlass: "rgba(2, 8, 14, 0.66)",
  whiteSoft: "rgba(237, 247, 255, 0.08)",
} as const;

export type LooiThemeColor = keyof typeof looiTheme;
