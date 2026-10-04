import type { Config } from "tailwindcss";

/**
 * Palette is fixed by the collection art. Dark only — there is no light theme,
 * because the pixel art is drawn against near-black and inverting it looks wrong.
 */
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        neon: "#22FF6A",
        pump: "#1FCB4F",
        ink: "#0A0D10",
        bone: "#F2F4F0",
        down: "#E4322B",
        // Derived surfaces, so components never invent their own greys.
        panel: "#111619",
        edge: "#1E262B",
        muted: "#7C8A91",
      },
      fontFamily: {
        display: ["var(--font-display)", "ui-monospace", "monospace"],
        body: ["var(--font-body)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        // Hard offset shadows only — no blur, to match the flat pixel aesthetic.
        pixel: "4px 4px 0 0 #0A0D10",
        "pixel-neon": "4px 4px 0 0 #22FF6A",
      },
    },
  },
  plugins: [],
} satisfies Config;
