import type { AppSettings, AccessMode, ThemePreference } from "../types";

type SettingsProps = {
  settings: AppSettings;
  onUpdateSettings: (partial: Partial<AppSettings>) => void;
};

const ACCESS_MODE_LABELS: Record<AccessMode, string> = {
  "read-only": "Read-only",
  current: "Current workspace",
  "full-access": "Full access",
};

export function Settings({ settings, onUpdateSettings }: SettingsProps) {
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
            <div className="settings-help">
              Changes apply immediately across all windows.
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
