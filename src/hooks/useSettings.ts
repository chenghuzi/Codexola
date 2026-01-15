import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getSettings, updateSettings } from "../services/tauri";
import type { AppSettings, ThemePreference } from "../types";

const DEFAULT_SETTINGS: AppSettings = {
  themePreference: "system",
  accessMode: "current",
  bypassApprovalsAndSandbox: false,
  enableWebSearchRequest: false,
  confirmBeforeQuit: false,
  enableCompletionNotifications: false,
  usagePollingEnabled: true,
  usagePollingIntervalMinutes: 5,
  sidebarWidth: 280,
  glassBlurLight: 32,
  glassBlurDark: 32,
  glassOpacityLight: 1,
  glassOpacityDark: 1,
  codexBinPath: null,
  workspaceSidebarExpanded: {},
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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function applyAppearance(settings: AppSettings, prefersDark: boolean) {
  const resolved = resolveTheme(settings.themePreference, prefersDark);
  applyTheme(resolved);
  const root = document.documentElement;
  const isDark = resolved === "dark";
  const blur = isDark ? settings.glassBlurDark : settings.glassBlurLight;
  const opacity = isDark
    ? settings.glassOpacityDark
    : settings.glassOpacityLight;
  const safeBlur = Math.max(0, blur);
  const safeOpacity = clamp(opacity, 0, 1);
  root.style.setProperty("--glass-blur", `${safeBlur}px`);
  root.style.setProperty("--glass-opacity", `${safeOpacity}`);
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
      applyAppearance(settings, media.matches);
    };
    apply();
    if (settings.themePreference === "system") {
      const handler = () => apply();
      media.addEventListener("change", handler);
      return () => media.removeEventListener("change", handler);
    }
    return undefined;
  }, [
    settings.themePreference,
    settings.glassBlurLight,
    settings.glassBlurDark,
    settings.glassOpacityLight,
    settings.glassOpacityDark,
  ]);

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
