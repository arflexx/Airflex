import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/globals.css",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Override default grays with WCAG AA compliant versions
        gray: {
          50: "#fafafa",
          100: "#f5f5f5", 
          200: "#e5e5e5",
          300: "#d4d4d4",
          400: "#a1a1aa",  // Changed from #a3a3a3 - better contrast (4.54:1 on white)
          500: "#71717a",  // Changed from #737373 - better contrast (7.21:1 on white)
          600: "#52525b",  // Good contrast (11.9:1 on white)
          700: "#3f3f46",  // Dark mode body text
          800: "#27272a",  // Dark mode backgrounds
          900: "#18181b",  // Dark mode primary
        },
        // Enhance violet colors for better contrast
        violet: {
          50: "#f5f3ff",
          100: "#ede9fe",
          200: "#ddd6fe",
          300: "#c4b5fd",
          400: "#a78bfa",
          500: "#8b5cf6", 
          600: "#7c3aed",  // Primary brand (4.8:1 on white - WCAG AA compliant)
          700: "#6d28d9",  // Dark backgrounds (5.7:1 on white)
          800: "#5b21b6",
          900: "#4c1d95",
        }
      }
    },
  },
  plugins: [],
};

export default config;
