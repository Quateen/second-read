import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#111111",
        "ink-soft": "#3b3b3b",
        bg: "#fafaf7",
        muted: "#6b6b6b",
        line: "#e4e2dc",
        info: "#0284c7",        // explicitly NOT green — see Notes on copy choices
        "info-soft": "#eaf1f8",
        warn: "#7a5d00",
        "warn-soft": "#fbf3d6",
        crit: "#7a1f1f",
        "crit-soft": "#f5e1e1",
      },
      fontFamily: {
        serif: ['"Iowan Old Style"', 'Charter', '"Source Serif Pro"', "Georgia", "serif"],
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Inter', '"Helvetica Neue"', "Arial", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
