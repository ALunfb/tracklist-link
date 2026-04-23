import type { Config } from "tailwindcss";

/**
 * Palette: audio-producer dark (Ableton Live / Reaper / FL Studio-inspired)
 *   - base: near-black with a violet tint so accents harmonize
 *   - surface: lighter panels for cards / tiles
 *   - accent: signature purple matching the Tracklist brand (#a855f7)
 *   - meter: reactive colors for level meters (green → amber → rose)
 */
const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        base: {
          950: "#070811",
          900: "#0b0d14",
          800: "#10131d",
          700: "#151926",
          600: "#1d2130",
        },
        surface: {
          DEFAULT: "#141824",
          hover: "#1a1f2d",
          border: "#232838",
          muted: "#2a2f3f",
        },
        accent: {
          DEFAULT: "#a855f7",
          dim: "#7c3aed",
          ghost: "rgba(168, 85, 247, 0.12)",
        },
        meter: {
          low: "#10b981",
          mid: "#f59e0b",
          hot: "#f43f5e",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      boxShadow: {
        glow: "0 0 24px -4px rgba(168, 85, 247, 0.35)",
        panel:
          "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 16px 40px -24px rgba(0,0,0,0.9)",
      },
      animation: {
        "pulse-slow": "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
    },
  },
  plugins: [],
};

export default config;
