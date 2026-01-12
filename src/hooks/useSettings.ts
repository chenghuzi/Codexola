import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getSettings, updateSettings } from "../services/tauri";
import type { AppSettings, ThemePreference } from "../types";

const DEFAULT_SETTINGS: AppSettings = {
  themePreference: "system",
  accessMode: "current",
  bypassApprovalsAndSandbox: false,
  enableWebSearchRequest: false,
};

function resolveTheme(preference: ThemePreference, prefersDark: boolean) {
  if (preference === "system") {
    return prefersDark ? "dark" : "light";
  }
  return preference;
}

function applyTheme(theme: "light" | "dark") {
  document.documentElement.setAttribute("data-theme", theme);
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let mounted = true;
    getSettings()
      .then((data) => {
        if (mounted) {
          setSettings(data);
        }
      })
      .catch(() => {
        if (mounted) {
          setSettings(DEFAULT_SETTINGS);
        }
      })
      .finally(() => {
        if (mounted) {
          setIsLoaded(true);
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = resolveTheme(settings.themePreference, media.matches);
      applyTheme(resolved);
    };
    apply();
    if (settings.themePreference === "system") {
      const handler = () => apply();
      media.addEventListener("change", handler);
      return () => media.removeEventListener("change", handler);
    }
    return undefined;
  }, [settings.themePreference]);

  useEffect(() => {
    const subscription = listen<AppSettings>("settings-updated", (event) => {
      setSettings(event.payload);
    });
    return () => {
      subscription.then((unlisten) => unlisten());
    };
  }, []);

  const persistSettings = useCallback(async (next: AppSettings) => {
    setSettings(next);
    try {
      const updated = await updateSettings(next);
      setSettings(updated);
    } catch {
      setSettings(next);
    }
  }, []);

  const update = useCallback(
    (partial: Partial<AppSettings>) => {
      const next = { ...settings, ...partial };
      persistSettings(next);
    },
    [persistSettings, settings],
  );

  return { settings, updateSettings: update, isLoaded };
}
