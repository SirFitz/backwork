import type { Config } from "tailwindcss";

const c = (v: string) => `oklch(var(${v}) / <alpha-value>)`;

export default {
  darkMode: "class",
  content: ["./app/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: c("--bg"),
        surface: c("--surface"),
        "surface-2": c("--surface-2"),
        border: c("--border"),
        "border-strong": c("--border-strong"),
        fg: c("--fg"),
        muted: c("--muted"),
        faint: c("--faint"),
        brand: { DEFAULT: c("--brand"), fg: c("--brand-fg") },
        ring: c("--ring"),
        ok: c("--ok"),
        warn: c("--warn"),
        err: c("--err"),
        info: c("--info"),
        accent: c("--accent"),
      },
      fontFamily: {
        sans: ['"Inter Variable"', "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono Variable"', "ui-monospace", "SF Mono", "Menlo", "monospace"],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      keyframes: {
        shimmer: { "100%": { transform: "translateX(100%)" } },
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
      },
      animation: {
        shimmer: "shimmer 1.4s infinite",
        "fade-in": "fade-in 0.25s ease-out",
      },
    },
  },
  plugins: [],
} satisfies Config;
