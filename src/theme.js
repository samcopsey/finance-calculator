const STORAGE_KEY = "theme";
const SYSTEM_DARK = "(prefers-color-scheme: dark)";

export function storedTheme() {
  try {
    const theme = localStorage.getItem(STORAGE_KEY);
    return theme === "light" || theme === "dark" ? theme : null;
  } catch {
    return null;
  }
}

export function systemTheme() {
  return window.matchMedia(SYSTEM_DARK).matches ? "dark" : "light";
}

export function initialTheme() {
  return storedTheme() ?? systemTheme();
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

export function saveTheme(theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private windows can block storage; the choice then lasts for this visit only.
  }
}

export function onSystemThemeChange(callback) {
  const query = window.matchMedia(SYSTEM_DARK);
  const listener = () => callback(systemTheme());
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
