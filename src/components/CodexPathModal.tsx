type CodexPathModalProps = {
  isOpen: boolean;
  path: string;
  testStatus: "idle" | "testing" | "success" | "error";
  testMessage?: string | null;
  canSave: boolean;
  onChangePath: (value: string) => void;
  onBrowse: () => void;
  onTest: () => void;
  onSave: () => void;
  onCancel?: () => void;
};

export function CodexPathModal({
  isOpen,
  path,
  testStatus,
  testMessage,
  canSave,
  onChangePath,
  onBrowse,
  onTest,
  onSave,
  onCancel,
}: CodexPathModalProps) {
  if (!isOpen) {
    return null;
  }

  const trimmed = path.trim();
  const isTesting = testStatus === "testing";
  const showStatus = testStatus === "success" || testStatus === "error";
  const statusText =
    testMessage ??
    (testStatus === "success"
      ? "Validation passed."
      : testStatus === "error"
        ? "Validation failed."
        : "");
  const canTest = trimmed.length > 0 && !isTesting;
  const saveDisabled = !canSave || isTesting;

  return (
    <div className="codex-path-overlay" role="presentation">
      <div
        className="codex-path-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="codex-path-title"
      >
        <div className="codex-path-title" id="codex-path-title">
          Set Codex binary path
        </div>
        <div className="codex-path-body">
          Codexola needs the Codex CLI to start app-server sessions. Provide the
          full path to the codex binary and validate it before saving.
        </div>
        <div className="codex-path-field">
          <label className="codex-path-label" htmlFor="codex-bin-path">
            Codex binary path
          </label>
          <div className="codex-path-row">
            <input
              id="codex-bin-path"
              className="codex-path-input"
              type="text"
              value={path}
              placeholder="/opt/homebrew/bin/codex"
              onChange={(event) => onChangePath(event.target.value)}
              spellCheck={false}
              data-tauri-drag-region="false"
            />
            <button
              className="secondary"
              type="button"
              onClick={onBrowse}
              disabled={isTesting}
            >
              Browse
            </button>
          </div>
          <div className="codex-path-hint">
            You can paste an absolute path or choose the binary with Browse.
          </div>
          {showStatus && (
            <div
              className={`codex-path-status ${
                testStatus === "success" ? "is-success" : "is-error"
              }`}
              role={testStatus === "error" ? "alert" : undefined}
            >
              {statusText}
            </div>
          )}
        </div>
        <div className="codex-path-actions">
          {onCancel && (
            <button className="secondary" type="button" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button
            className="ghost"
            type="button"
            onClick={onTest}
            disabled={!canTest}
          >
            {isTesting ? "Testing..." : "Test"}
          </button>
          <button
            className="primary"
            type="button"
            onClick={onSave}
            disabled={saveDisabled}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
