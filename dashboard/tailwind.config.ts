import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // observability dark palette
        bg: "#0a0c10",
        panel: "#11141b",
        "panel-2": "#161a23",
        border: "#222835",
        muted: "#7b8493",
        fg: "#e6e9ef",
        // brand coral (from the backwork brief)
        brand: {
          DEFAULT: "#ef5a78",
          dim: "#b23a54",
        },
        ok: "#3fb950",
        warn: "#d8a657",
        err: "#f85149",
        info: "#58a6ff",
        accent: "#a371f7",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      keyframes: {
        pulse: {
          "0%,100%": { opacity: "1" },
          "50%": { opacity: "0.4" },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
