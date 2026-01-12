import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent } from "react";
import type { ComposerAttachment, SlashItem } from "../types";
import { SlashMenu } from "./SlashMenu";
import { filterSlashItems } from "../utils/slash";

type ComposerProps = {
  onSend: (text: string, attachments: ComposerAttachment[]) => void;
  disabled?: boolean;
  isSavingAttachments?: boolean;
  attachments: ComposerAttachment[];
  onAddAttachments: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  models: { id: string; displayName: string; model: string }[];
  selectedModelId: string | null;
  onSelectModel: (id: string) => void;
  reasoningOptions: string[];
  selectedEffort: string | null;
  onSelectEffort: (effort: string) => void;
  accessMode: "read-only" | "current" | "full-access";
  onSelectAccessMode: (mode: "read-only" | "current" | "full-access") => void;
  skills: { name: string; description?: string }[];
  slashItems: SlashItem[];
};

export function Composer({
  onSend,
  disabled = false,
  isSavingAttachments = false,
  attachments,
  onAddAttachments,
  onRemoveAttachment,
  models,
  selectedModelId,
  onSelectModel,
  reasoningOptions,
  selectedEffort,
  onSelectEffort,
  accessMode,
  onSelectAccessMode,
  skills,
  slashItems,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const canSend = useMemo(
    () => !disabled && !isSavingAttachments && (!!text.trim() || attachments.length > 0),
    [attachments.length, disabled, isSavingAttachments, text],
  );
  const slashQuery = useMemo(() => {
    if (!text.startsWith("/")) {
      return null;
    }
    if (text.includes("\n")) {
      return null;
    }
    const query = text.slice(1);
    if (query.includes(" ")) {
      return null;
    }
    return query;
  }, [text]);
  const isSlashOpen = Boolean(slashQuery !== null && !disabled);
  const filteredSlashItems = useMemo(() => {
    if (!isSlashOpen || slashQuery === null) {
      return [];
    }
    return filterSlashItems(slashItems, slashQuery);
  }, [isSlashOpen, slashItems, slashQuery]);

  useEffect(() => {
    if (!isSlashOpen) {
      setSlashIndex(0);
      return;
    }
    setSlashIndex((prev) => {
      if (filteredSlashItems.length === 0) {
        return 0;
      }
      return Math.min(prev, filteredSlashItems.length - 1);
    });
  }, [filteredSlashItems.length, isSlashOpen, slashQuery]);

  const handleSend = useCallback(() => {
    if (!canSend) {
      return;
    }
    onSend(text, attachments);
    setText("");
  }, [attachments, canSend, onSend, text]);

  const handleSelectSlashItem = useCallback((item: SlashItem) => {
    setText(item.insertText);
    setSlashIndex(0);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, []);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (disabled) {
        return;
      }
      const items = Array.from(event.clipboardData?.items ?? []);
      const files = items
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file));
      if (files.length > 0) {
        const hasText = Boolean(event.clipboardData?.getData("text/plain"));
        onAddAttachments(files);
        if (!hasText) {
          event.preventDefault();
        }
      }
    },
    [disabled, onAddAttachments],
  );

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLTextAreaElement>) => {
      if (disabled) {
        return;
      }
      const hasFiles = Array.from(event.dataTransfer?.items ?? []).some(
        (item) => item.kind === "file",
      );
      if (hasFiles) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }
    },
    [disabled],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLTextAreaElement>) => {
      if (disabled) {
        return;
      }
      const files = Array.from(event.dataTransfer?.files ?? []).filter((file) =>
        file.type.startsWith("image/"),
      );
      if (files.length > 0) {
        event.preventDefault();
        onAddAttachments(files);
      }
    },
    [disabled, onAddAttachments],
  );

  const handleSelectSkill = useCallback((name: string) => {
    const snippet = `$${name}`;
    setText((prev) => {
      const trimmed = prev.trim();
      if (!trimmed) {
        return snippet + " ";
      }
      if (trimmed.includes(snippet)) {
        return prev;
      }
      return `${prev.trim()} ${snippet} `;
    });
  }, []);

  return (
    <footer className={`composer${disabled ? " is-disabled" : ""}`}>
      <div className="composer-input">
        <div className="composer-field">
          <textarea
            placeholder={
              disabled
                ? "Review in progress. Chat will re-enable when it completes."
                : "Ask Codex to do something... (paste or drop images)"
            }
            value={text}
            onChange={(event) => setText(event.target.value)}
            disabled={disabled}
            onPaste={handlePaste}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            ref={textareaRef}
            onKeyDown={(event) => {
              if (disabled) {
                return;
              }
              if (event.key === "Enter" && event.metaKey) {
                event.preventDefault();
                handleSend();
                return;
              }
              if (isSlashOpen) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  if (filteredSlashItems.length > 0) {
                    setSlashIndex((prev) =>
                      (prev + 1) % filteredSlashItems.length,
                    );
                  }
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  if (filteredSlashItems.length > 0) {
                    setSlashIndex((prev) =>
                      (prev - 1 + filteredSlashItems.length) %
                      filteredSlashItems.length,
                    );
                  }
                  return;
                }
                if (event.key === "Enter") {
                  if (filteredSlashItems.length > 0) {
                    event.preventDefault();
                    handleSelectSlashItem(filteredSlashItems[slashIndex]);
                  }
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setText("");
                }
              }
            }}
          />
          {isSlashOpen && (
            <SlashMenu
              items={filteredSlashItems}
              selectedIndex={slashIndex}
              onSelect={handleSelectSlashItem}
              onHover={(index) => setSlashIndex(index)}
            />
          )}
          {attachments.length > 0 && (
            <div className="composer-attachments">
              {attachments.map((attachment) => (
                <div key={attachment.id} className="composer-attachment">
                  <img src={attachment.previewUrl} alt={attachment.name} />
                  <button
                    type="button"
                    className="composer-attachment-remove"
                    onClick={() => onRemoveAttachment(attachment.id)}
                    aria-label={`Remove ${attachment.name}`}
                    disabled={disabled}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <button
          className="composer-send"
          onClick={handleSend}
          disabled={!canSend}
        >
          {isSavingAttachments ? "Saving..." : "Send (cmd+enter)"}
        </button>
      </div>
      <div className="composer-bar">
        <div className="composer-meta">
          <div className="composer-select-wrap">
            <span className="composer-icon" aria-hidden>
              <svg viewBox="0 0 24 24" fill="none">
                <path
                  d="M7 8V6a5 5 0 0 1 10 0v2"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
                <rect
                  x="4.5"
                  y="8"
                  width="15"
                  height="11"
                  rx="3"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <circle cx="9" cy="13" r="1" fill="currentColor" />
                <circle cx="15" cy="13" r="1" fill="currentColor" />
                <path
                  d="M9 16h6"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <select
              className="composer-select composer-select--model"
              aria-label="Model"
              value={selectedModelId ?? ""}
              onChange={(event) => onSelectModel(event.target.value)}
              disabled={disabled}
            >
              {models.length === 0 && <option value="">No models</option>}
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName || model.model}
                </option>
              ))}
            </select>
          </div>
          <div className="composer-select-wrap">
            <span className="composer-icon" aria-hidden>
              <svg viewBox="0 0 24 24" fill="none">
                <path
                  d="M8.5 4.5a3.5 3.5 0 0 0-3.46 4.03A4 4 0 0 0 6 16.5h2"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
                <path
                  d="M15.5 4.5a3.5 3.5 0 0 1 3.46 4.03A4 4 0 0 1 18 16.5h-2"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
                <path
                  d="M9 12h6"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
                <path
                  d="M12 12v6"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <select
              className="composer-select composer-select--effort"
              aria-label="Thinking mode"
              value={selectedEffort ?? ""}
              onChange={(event) => onSelectEffort(event.target.value)}
              disabled={disabled}
            >
              {reasoningOptions.length === 0 && (
                <option value="">Default</option>
              )}
              {reasoningOptions.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
          </div>
          <div className="composer-select-wrap">
            <span className="composer-icon" aria-hidden>
              <svg viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 4l7 3v5c0 4.5-3 7.5-7 8-4-0.5-7-3.5-7-8V7l7-3z"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
                <path
                  d="M9.5 12.5l1.8 1.8 3.7-4"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <select
              className="composer-select composer-select--approval"
              aria-label="Agent access"
              disabled={disabled}
              value={accessMode}
              onChange={(event) =>
                onSelectAccessMode(
                  event.target.value as "read-only" | "current" | "full-access",
                )
              }
            >
              <option value="read-only">Read only</option>
              <option value="current">Current</option>
              <option value="full-access">Full access</option>
            </select>
          </div>
          <div className="composer-select-wrap">
            <span className="composer-icon" aria-hidden>
              <svg viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 4v5m0 6v5M4 12h5m6 0h5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
                <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            </span>
            <select
              className="composer-select composer-select--skill"
              aria-label="Skills"
              onChange={(event) => {
                const value = event.target.value;
                if (value) {
                  handleSelectSkill(value);
                  event.target.value = "";
                }
              }}
              disabled={disabled}
            >
              <option value="">Skill</option>
              {skills.map((skill) => (
                <option key={skill.name} value={skill.name}>
                  {skill.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </footer>
  );
}
