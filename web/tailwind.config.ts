import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        slate: {
          // Kênh RGB để bg-slate-900/60 ... (độ trong suốt) hoạt động với biến theme
          950: "rgb(var(--slate-950) / <alpha-value>)",
          900: "rgb(var(--slate-900) / <alpha-value>)",
          850: "rgb(var(--slate-850) / <alpha-value>)",
          800: "rgb(var(--slate-800) / <alpha-value>)",
          750: "rgb(var(--slate-750) / <alpha-value>)",
          700: "rgb(var(--slate-700) / <alpha-value>)",
          650: "rgb(var(--slate-650) / <alpha-value>)",
          600: "rgb(var(--slate-600) / <alpha-value>)",
          500: "rgb(var(--slate-500) / <alpha-value>)",
          450: "rgb(var(--slate-450) / <alpha-value>)",
          400: "rgb(var(--slate-400) / <alpha-value>)",
          350: "rgb(var(--slate-350) / <alpha-value>)",
          300: "rgb(var(--slate-300) / <alpha-value>)",
          250: "rgb(var(--slate-250) / <alpha-value>)",
          200: "rgb(var(--slate-200) / <alpha-value>)",
          100: "rgb(var(--slate-100) / <alpha-value>)",
        },
      },
    },
  },
  plugins: [],
};

export default config;
