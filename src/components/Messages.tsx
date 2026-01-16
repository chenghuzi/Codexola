import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ConversationItem } from "../types";
import { Markdown } from "./Markdown";
import { DiffBlock } from "./DiffBlock";
import { languageFromPath } from "../utils/syntax";

type MessagesProps = {
  items: ConversationItem[];
  isThinking: boolean;
  isCanceling: boolean;
  onCancel?: () => void;
};

export function Messages({
  items,
  isThinking,
  isCanceling,
  onCancel,
}: MessagesProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const seenItems = useRef(new Set<string>());
  const [openItems, setOpenItems] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const maxVisibleItems = 30;

  const attachmentSrc = useMemo(
    () => (path: string) => {
      if (!path) {
        return "";
      }
      if (path.startsWith("data:") || path.startsWith("http")) {
        return path;
      }
      return convertFileSrc(path);
    },
    [],
  );

  const visibleItems =
    !showAll && items.length > maxVisibleItems
      ? items.slice(-maxVisibleItems)
      : items;

  const streamingMessageId = useMemo(() => {
    if (!isThinking) {
      return null;
    }
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const entry = items[index];
      if (entry.kind === "message" && entry.role === "assistant") {
        return entry.id;
      }
    }
    return null;
  }, [items, isThinking]);

  useEffect(() => {
    setOpenItems((prev) => {
      let changed = false;
      const next = new Set(prev);
      items.forEach((item) => {
        if (seenItems.current.has(item.id)) {
          return;
        }
        seenItems.current.add(item.id);
        const shouldOpen =
          item.kind === "tool" && item.toolType === "fileChange";
        if (shouldOpen) {
          next.add(item.id);
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [items]);

  useEffect(() => {
    if (!bottomRef.current) {
      return undefined;
    }
    let raf1 = 0;
    let raf2 = 0;
    const target = bottomRef.current;
    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        target.scrollIntoView({ behavior: "smooth", block: "end" });
      });
    });
    return () => {
      if (raf1) {
        window.cancelAnimationFrame(raf1);
      }
      if (raf2) {
        window.cancelAnimationFrame(raf2);
      }
    };
  }, [items.length, isThinking]);

  return (
    <div
      ref={listRef}
      className="messages messages-full"
      onScroll={() => {
        const node = listRef.current;
        if (!node) {
          return;
        }
        const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
        if (!showAll && node.scrollTop <= 80) {
          setShowAll(true);
        } else if (showAll && distanceFromBottom <= 80) {
          setShowAll(false);
        }
      }}
    >
      {visibleItems.map((item) => {
        if (item.kind === "message") {
          const attachments = item.attachments ?? [];
          const showCancel =
            Boolean(onCancel) &&
            isThinking &&
            item.role === "assistant" &&
            item.id === streamingMessageId;
          return (
            <div key={item.id} className={`message ${item.role}`}>
              <div className="message-row">
                <div className="bubble">
                  {item.text && <Markdown value={item.text} className="markdown" />}
                  {attachments.length > 0 && (
                    <div className="message-attachments">
                      {attachments.map((attachment, index) => {
                        const src = attachmentSrc(attachment.path);
                        if (!src) {
                          return null;
                        }
                        return (
                          <img
                            key={`${item.id}-attachment-${index}`}
                            src={src}
                            alt="attachment"
                            className="message-attachment"
                            loading="lazy"
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
                {showCancel && (
                  <button
                    className="message-cancel"
                    onClick={onCancel}
                    disabled={isCanceling}
                    aria-label="Cancel"
                  >
                    {isCanceling ? "Cancelling..." : "Cancel"}
                  </button>
                )}
              </div>
            </div>
          );
        }
        if (item.kind === "reasoning") {
          const summaryText = item.summary || item.content;
          const summaryLines = summaryText
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
          const rawTitle =
            summaryLines.length > 0
              ? summaryLines[summaryLines.length - 1]
              : "Reasoning";
          const cleanTitle = rawTitle
            .replace(/[`*_~]/g, "")
            .replace(/\[(.*?)\]\(.*?\)/g, "$1")
            .trim();
          const summaryTitle =
            cleanTitle.length > 80
              ? `${cleanTitle.slice(0, 80)}…`
              : cleanTitle || "Reasoning";
          return (
            <details
              key={item.id}
              className="item-card reasoning"
              open={openItems.has(item.id)}
              onToggle={(event) => {
                const isOpen = event.currentTarget.open;
                setOpenItems((prev) => {
                  const next = new Set(prev);
                  if (isOpen) {
                    next.add(item.id);
                  } else {
                    next.delete(item.id);
                  }
                  return next;
                });
              }}
            >
              <summary>
                <span className="item-summary-left">
                  <span className="item-chevron" aria-hidden>
                    ▸
                  </span>
                  <span className="item-title">{summaryTitle}</span>
                </span>
              </summary>
              <div className="item-body">
                {item.summary && (
                  <Markdown value={item.summary} className="item-text markdown" />
                )}
                {item.content && (
                  <Markdown value={item.content} className="item-text markdown" />
                )}
              </div>
            </details>
          );
        }
        if (item.kind === "review") {
          const title =
            item.state === "started" ? "Review started" : "Review completed";
          return (
            <div key={item.id} className="item-card review">
              <div className="review-header">
                <span className="review-title">{title}</span>
                <span
                  className={`review-badge ${
                    item.state === "started" ? "active" : "done"
                  }`}
                >
                  Review
                </span>
              </div>
              {item.text && (
                <Markdown value={item.text} className="item-text markdown" />
              )}
            </div>
          );
        }
        if (item.kind === "diff") {
          return (
            <details key={item.id} className="item-card tool">
              <summary>
                <span className="item-summary-left">
                  <span className="item-chevron" aria-hidden>
                    ▸
                  </span>
                  <span className="item-title">{item.title}</span>
                </span>
                {item.status && <span className="item-status">{item.status}</span>}
              </summary>
              <div className="item-body">
                <div className="diff-viewer-output">
                  <DiffBlock diff={item.diff} language="diff" />
                </div>
              </div>
            </details>
          );
        }
        if (item.kind !== "tool") {
          return null;
        }
        const isFileChange = item.toolType === "fileChange";
        return (
          <details
            key={item.id}
            className="item-card tool"
            open={isFileChange ? openItems.has(item.id) : undefined}
            onToggle={
              isFileChange
                ? (event) => {
                    const isOpen = event.currentTarget.open;
                    setOpenItems((prev) => {
                      const next = new Set(prev);
                      if (isOpen) {
                        next.add(item.id);
                      } else {
                        next.delete(item.id);
                      }
                      return next;
                    });
                  }
                : undefined
            }
          >
            <summary>
              <span className="item-summary-left">
                <span className="item-chevron" aria-hidden>
                  ▸
                </span>
                <span className="item-title">{item.title}</span>
              </span>
              {item.status && <span className="item-status">{item.status}</span>}
            </summary>
            <div className="item-body">
              {!isFileChange && item.detail && (
                <Markdown value={item.detail} className="item-text markdown" />
              )}
              {isFileChange && item.changes?.length ? (
                <div className="file-change-list">
                  {item.changes.map((change, index) => (
                    <div
                      key={`${change.path}-${index}`}
                      className="file-change"
                    >
                      <div className="file-change-header">
                        {change.kind && (
                          <span className="file-change-kind">
                            {change.kind.toUpperCase()}
                          </span>
                        )}
                        <span className="file-change-path">{change.path}</span>
                      </div>
                      {change.diff && (
                        <div className="diff-viewer-output">
                          <DiffBlock
                            diff={change.diff}
                            language={languageFromPath(change.path)}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : null}
              {isFileChange && !item.changes?.length && item.detail && (
                <Markdown value={item.detail} className="item-text markdown" />
              )}
              {item.output && (!isFileChange || !item.changes?.length) && (
                <Markdown
                  value={item.output}
                  className="item-output markdown"
                  codeBlock
                />
              )}
            </div>
          </details>
        );
      })}
      {isThinking && (
        <div className="thinking">Codex is thinking...</div>
      )}
      {!items.length && (
        <div className="empty messages-empty">
          Start a thread and send a prompt to the agent.
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
