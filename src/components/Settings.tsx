import type { AppSettings, AccessMode, ThemePreference } from "../types";

type SettingsProps = {
  settings: AppSettings;
  onUpdateSettings: (partial: Partial<AppSettings>) => void;
  onOpenCodexPathModal: () => void;
};

const ACCESS_MODE_LABELS: Record<AccessMode, string> = {
  "read-only": "Read-only",
  current: "Current workspace",
  "full-access": "Full access",
};

export function Settings({
  settings,
  onUpdateSettings,
  onOpenCodexPathModal,
}: SettingsProps) {
  return (
    <div className="settings-shell">
      <header className="settings-header" data-tauri-drag-region>
        <nav
          className="settings-tabs"
          aria-label="Preferences"
          role="tablist"
          aria-orientation="horizontal"
          data-tauri-drag-region="false"
        >
          <button
            className="settings-tab is-active"
            type="button"
            role="tab"
            aria-selected="true"
          >
            General
          </button>
          <button className="settings-tab" type="button" role="tab">
            Agents
          </button>
          <button className="settings-tab" type="button" role="tab">
            Security
          </button>
        </nav>
      </header>
      <div className="settings-body">
        <main className="settings-panel" data-tauri-drag-region="false">
          <div className="settings-panel-header">
            <div className="settings-panel-title">General</div>
            <div className="settings-panel-subtitle">
              App-wide behavior and defaults.
            </div>
          </div>
          <div className="settings-card">
            <div className="settings-card-title">Appearance</div>
            <div className="settings-field">
              <label className="settings-label" htmlFor="theme-preference">
                Theme
              </label>
              <select
                id="theme-preference"
                className="settings-select"
                value={settings.themePreference}
                onChange={(event) =>
                  onUpdateSettings({
                    themePreference: event.target.value as ThemePreference,
                  })
                }
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </div>
            <div className="settings-subsection">
              <div className="settings-subsection-title">Light mode glass</div>
              <div className="settings-field">
                <label className="settings-label" htmlFor="glass-blur-light">
                  Frost blur
                </label>
                <div className="settings-slider-row">
                  <input
                    id="glass-blur-light"
                    className="settings-slider"
                    type="range"
                    min="0"
                    max="40"
                    step="1"
                    value={settings.glassBlurLight}
                    onChange={(event) =>
                      onUpdateSettings({
                        glassBlurLight: Number(event.target.value),
                      })
                    }
                  />
                  <div className="settings-slider-value">
                    {Math.round(settings.glassBlurLight)}px
                  </div>
                </div>
              </div>
              <div className="settings-field">
                <label className="settings-label" htmlFor="glass-opacity-light">
                  Opacity
                </label>
                <div className="settings-slider-row">
                  <input
                    id="glass-opacity-light"
                    className="settings-slider"
                    type="range"
                    min="0"
                    max="1"
                    step="0.02"
                    value={settings.glassOpacityLight}
                    onChange={(event) =>
                      onUpdateSettings({
                        glassOpacityLight: Number(event.target.value),
                      })
                    }
                  />
                  <div className="settings-slider-value">
                    {Math.round(settings.glassOpacityLight * 100)}%
                  </div>
                </div>
              </div>
            </div>
            <div className="settings-subsection">
              <div className="settings-subsection-title">Dark mode glass</div>
              <div className="settings-field">
                <label className="settings-label" htmlFor="glass-blur-dark">
                  Frost blur
                </label>
                <div className="settings-slider-row">
                  <input
                    id="glass-blur-dark"
                    className="settings-slider"
                    type="range"
                    min="0"
                    max="40"
                    step="1"
                    value={settings.glassBlurDark}
                    onChange={(event) =>
                      onUpdateSettings({
                        glassBlurDark: Number(event.target.value),
                      })
                    }
                  />
                  <div className="settings-slider-value">
                    {Math.round(settings.glassBlurDark)}px
                  </div>
                </div>
              </div>
              <div className="settings-field">
                <label className="settings-label" htmlFor="glass-opacity-dark">
                  Opacity
                </label>
                <div className="settings-slider-row">
                  <input
                    id="glass-opacity-dark"
                    className="settings-slider"
                    type="range"
                    min="0"
                    max="1"
                    step="0.02"
                    value={settings.glassOpacityDark}
                    onChange={(event) =>
                      onUpdateSettings({
                        glassOpacityDark: Number(event.target.value),
                      })
                    }
                  />
                  <div className="settings-slider-value">
                    {Math.round(settings.glassOpacityDark * 100)}%
                  </div>
                </div>
              </div>
            </div>
            <div className="settings-help">
              Changes apply immediately across all windows. 100% is the most
              opaque setting.
            </div>
          </div>
          <div className="settings-card">
            <div className="settings-card-title">Defaults</div>
            <div className="settings-field">
              <label className="settings-label" htmlFor="access-mode-default">
                Default access mode
              </label>
              <select
                id="access-mode-default"
                className="settings-select"
                value={settings.accessMode}
                onChange={(event) =>
                  onUpdateSettings({
                    accessMode: event.target.value as AccessMode,
                  })
                }
              >
                {Object.entries(ACCESS_MODE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="settings-help">
              New sessions and requests use this access mode by default.
            </div>
          </div>
          <div className="settings-card">
            <div className="settings-card-title">Codex CLI</div>
            <div className="settings-card-body">
              Set the codex binary used to start app-server sessions.
            </div>
            <div className="settings-field">
              <label className="settings-label">Codex binary path</label>
              <div className="settings-inline">
                <div className="settings-path">
                  {settings.codexBinPath?.trim()
                    ? settings.codexBinPath
                    : "Not set"}
                </div>
                <button
                  className="secondary"
                  type="button"
                  onClick={onOpenCodexPathModal}
                >
                  {settings.codexBinPath?.trim() ? "Change" : "Set path"}
                </button>
              </div>
            </div>
          </div>
          <div className="settings-card">
            <div className="settings-card-title">Quit behavior</div>
            <div className="settings-toggle">
              <input
                id="confirm-before-quit"
                type="checkbox"
                checked={settings.confirmBeforeQuit}
                onChange={(event) =>
                  onUpdateSettings({
                    confirmBeforeQuit: event.target.checked,
                  })
                }
              />
              <label htmlFor="confirm-before-quit">
                Confirm before quitting (Cmd+Q)
              </label>
            </div>
            <div className="settings-help">
              When enabled, quitting the app requires confirmation.
            </div>
          </div>
          <div className="settings-card">
            <div className="settings-card-title">Notifications</div>
            <div className="settings-toggle">
              <input
                id="completion-notifications"
                type="checkbox"
                checked={settings.enableCompletionNotifications}
                onChange={(event) =>
                  onUpdateSettings({
                    enableCompletionNotifications: event.target.checked,
                  })
                }
              />
              <label htmlFor="completion-notifications">
                Notify when an agent finishes a reply
              </label>
            </div>
            <div className="settings-help">
              Clicking the notification opens the related thread.
            </div>
          </div>
          <div className="settings-card">
            <div className="settings-card-title">Usage polling</div>
            <div className="settings-toggle">
              <input
                id="usage-polling-enabled"
                type="checkbox"
                checked={settings.usagePollingEnabled}
                onChange={(event) =>
                  onUpdateSettings({
                    usagePollingEnabled: event.target.checked,
                  })
                }
              />
              <label htmlFor="usage-polling-enabled">
                Enable background usage refresh
              </label>
            </div>
            <div className="settings-field">
              <label
                className="settings-label"
                htmlFor="usage-polling-interval"
              >
                Refresh interval (minutes)
              </label>
              <input
                id="usage-polling-interval"
                className="settings-select"
                type="number"
                min="1"
                max="120"
                step="1"
                value={settings.usagePollingIntervalMinutes}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (!Number.isFinite(value)) {
                    return;
                  }
                  const next = Math.max(1, Math.min(120, Math.round(value)));
                  onUpdateSettings({ usagePollingIntervalMinutes: next });
                }}
                disabled={!settings.usagePollingEnabled}
              />
            </div>
            <div className="settings-help">
              Controls how often the app refreshes usage data for the sidebar.
            </div>
          </div>
          <div className="settings-card">
            <div className="settings-card-title">Advanced runtime flags</div>
            <div className="settings-toggle">
              <input
                id="bypass-approvals"
                type="checkbox"
                checked={settings.bypassApprovalsAndSandbox}
                onChange={(event) =>
                  onUpdateSettings({
                    bypassApprovalsAndSandbox: event.target.checked,
                  })
                }
              />
              <label htmlFor="bypass-approvals">
                Bypass approvals and sandbox restrictions
              </label>
            </div>
            <div className="settings-toggle">
              <input
                id="enable-web-search"
                type="checkbox"
                checked={settings.enableWebSearchRequest}
                onChange={(event) =>
                  onUpdateSettings({
                    enableWebSearchRequest: event.target.checked,
                  })
                }
              />
              <label htmlFor="enable-web-search">
                Enable web search requests
              </label>
            </div>
            <div className="settings-help">
              Changes apply to new app-server sessions only.
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
