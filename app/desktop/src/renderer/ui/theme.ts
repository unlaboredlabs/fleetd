import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_MODES: ReadonlyArray<{ value: ThemeMode; label: string }> = [
  { value: "system", label: "Match system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** `system` follows the OS and changes with it; the explicit modes do not. */
export function resolveTheme(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  if (mode === "system") return systemDark ? "dark" : "light";
  return mode;
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

const STORAGE_KEY = "fleetd.theme";
const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

function storedMode(): ThemeMode {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return isThemeMode(v) ? v : "system";
  } catch {
    return "system";
  }
}

/** Sets data-theme on <html>. Call before the first render so the first paint is themed. */
export function applyTheme(mode: ThemeMode = storedMode()): ResolvedTheme {
  const resolved = resolveTheme(mode, darkQuery().matches);
  document.documentElement.dataset["theme"] = resolved;
  return resolved;
}

interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

/**
 * Owns the light/dark choice. `initialMode` wins over the stored choice (the gallery uses it); `onModeChange`
 * lets the shell mirror the choice to nativeTheme so menus and dialogs match.
 */
export function ThemeProvider(props: {
  children: ReactNode;
  initialMode?: ThemeMode;
  onModeChange?: (mode: ThemeMode) => void;
}) {
  const { onModeChange } = props;
  const [mode, setModeState] = useState<ThemeMode>(() => props.initialMode ?? storedMode());
  const [systemDark, setSystemDark] = useState(() => darkQuery().matches);

  useEffect(() => {
    const q = darkQuery();
    const onChange = () => setSystemDark(q.matches);
    q.addEventListener("change", onChange);
    return () => q.removeEventListener("change", onChange);
  }, []);

  const resolved = resolveTheme(mode, systemDark);
  useEffect(() => {
    document.documentElement.dataset["theme"] = resolved;
  }, [resolved]);

  const setMode = useCallback(
    (next: ThemeMode) => {
      setModeState(next);
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Storage can be unavailable (a locked profile); the choice still holds for this run.
      }
      onModeChange?.(next);
    },
    [onModeChange],
  );

  const value = useMemo(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);
  return createElement(ThemeContext.Provider, { value }, props.children);
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme needs a <ThemeProvider> (wrap the app in <UiProvider>).");
  return ctx;
}
