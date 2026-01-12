type ConfirmQuitModalProps = {
  isOpen: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmQuitModal({
  isOpen,
  onCancel,
  onConfirm,
}: ConfirmQuitModalProps) {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="confirm-quit-overlay" role="presentation">
      <div
        className="confirm-quit-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-quit-title"
      >
        <div className="confirm-quit-title" id="confirm-quit-title">
          Quit Codexia?
        </div>
        <div className="confirm-quit-body">
          You can keep the app running and return to your sessions later.
        </div>
        <div className="confirm-quit-actions">
          <button className="secondary" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="primary" type="button" onClick={onConfirm}>
            Quit
          </button>
        </div>
      </div>
    </div>
  );
}
