export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          0: "#0a0a0f",
          1: "#111118",
          2: "#15151e",
          3: "#1c1c28",
          4: "#252536",
          5: "#2f2f42",
        },
        border: {
          DEFAULT: "#272735",
          light: "#35354a",
        },
        accent: {
          DEFAULT: "#22d3ee",
          hover: "#67e8f9",
          dim: "#0891b2",
        },
        status: {
          working: "#34d399",
          waiting: "#fbbf24",
          error: "#f87171",
          completed: "#94a3b8",
        },
      },
      fontFamily: {
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "Consolas", "monospace"],
      },
      animation: {
        "fade-in": "fadeIn 0.3s ease-out",
        "slide-up": "slideUp 0.3s ease-out",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};
