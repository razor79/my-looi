/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,jsx,ts,tsx}",
    "./src/**/*.{js,jsx,ts,tsx}",
    "./components/**/*.{js,jsx,ts,tsx}",
  ],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        "looi-bg": "#03070d",
        "looi-bg-raised": "#07111d",
        "looi-surface": "rgba(8, 18, 30, 0.72)",
        "looi-line": "rgba(84, 167, 255, 0.22)",
        "looi-line-active": "rgba(40, 213, 255, 0.72)",
        "looi-text": "#edf7ff",
        "looi-muted": "#8c9bad",
        "looi-cyan": "#28d5ff",
        "looi-blue": "#1f7cff",
        "looi-ok": "#4de7b4",
        "looi-warn": "#ffd166",
        "looi-danger": "#ff5c7a",
      },
      borderRadius: {
        "looi-card": 22,
        "looi-pill": 999,
      },
      boxShadow: {
        "looi-glow": "0 0 22px rgba(40, 213, 255, 0.42)",
      },
      fontSize: {
        "looi-hero": [44, { lineHeight: 52, fontWeight: "700" }],
        "looi-title": [30, { lineHeight: 38, fontWeight: "700" }],
        "looi-card": [18, { lineHeight: 26, fontWeight: "600" }],
      },
    },
  },
  plugins: [],
};
