/**
 * The dark-mode preference, and the one place that applies it.
 *
 * Settings writes the choice into its "pinearn.prefs" blob and toggled the
 * `dark` class on <html> inline — which meant the theme only held while that
 * page was mounted. Any reload or full navigation dropped back to light, so the
 * toggle looked broken even though the preference had been saved correctly.
 * Reading it here lets the root apply it on every boot.
 */
export type Theme = "light" | "dark";

const PREFS_KEY = "pinearn.prefs";

export function readTheme(): Theme {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return "light";
    return (JSON.parse(raw) as { theme?: Theme }).theme === "dark" ? "dark" : "light";
  } catch {
    // Private mode or a corrupt value — light is the safe default.
    return "light";
  }
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}
