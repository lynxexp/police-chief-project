import { useEffect, useState } from "react";

export type ThemeMode = "light" | "dark";

const STORAGE_KEY = "pc:theme";

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function readStored(): ThemeMode | null {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" ? v : null;
}

function applyTheme(mode: ThemeMode | null) {
  if (mode) document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
}

/**
 * Explicit Dark/Light pick from the rail's toggle, persisted in
 * localStorage -- overrides prefers-color-scheme (via data-theme on
 * <html>, see index.css) once the user picks one. Until then, this
 * follows the OS setting live (including OS-level changes while the
 * page is open).
 */
export function useThemePreference(): { theme: ThemeMode; setTheme: (m: ThemeMode) => void } {
  const [explicit, setExplicit] = useState<ThemeMode | null>(() => {
    try {
      return readStored();
    } catch {
      return null;
    }
  });
  const [systemDark, setSystemDark] = useState(() => {
    try {
      return systemPrefersDark();
    } catch {
      return true;
    }
  });

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    applyTheme(explicit);
  }, [explicit]);

  const theme: ThemeMode = explicit ?? (systemDark ? "dark" : "light");

  function setTheme(mode: ThemeMode) {
    setExplicit(mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* private mode / storage disabled -- toggle still works this session, just doesn't persist */
    }
  }

  return { theme, setTheme };
}
