import type {
  RateLimitSnapshot,
  ThreadSummary,
  UsageSnapshot,
  WorkspaceInfo,
} from "../types";
import { useState } from "react";
import { Menu, MenuItem } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";

type SidebarProps = {
  workspaces: WorkspaceInfo[];
  threadsByWorkspace: Record<string, ThreadSummary[]>;
  threadStatusById: Record<
    string,
    {
      isProcessing: boolean;
      hasUnread: boolean;
      isReviewing: boolean;
      isCanceling: boolean;
    }
  >;
  usageSnapshot: UsageSnapshot | null;
  activeWorkspaceId: string | null;
  activeThreadId: string | null;
  expandedWorkspaceIds: Record<string, boolean>;
  removingWorkspaceIds: Set<string>;
  onAddWorkspace: () => void;
  onConnectWorkspace: (workspace: WorkspaceInfo) => void;
  onAddAgent: (workspace: WorkspaceInfo) => void;
  onRemoveWorkspace: (workspace: WorkspaceInfo) => void;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onRenameThread: (workspaceId: string, threadId: string, name: string) => void;
  onArchiveThread: (
    workspaceId: string,
    threadId: string,
    archived: boolean,
  ) => void;
  onToggleWorkspaceExpanded: (workspaceId: string) => void;
};

export function Sidebar({
  workspaces,
  threadsByWorkspace,
  threadStatusById,
  usageSnapshot,
  activeWorkspaceId,
  activeThreadId,
  expandedWorkspaceIds,
  removingWorkspaceIds,
  onAddWorkspace,
  onConnectWorkspace,
  onAddAgent,
  onRemoveWorkspace,
  onSelectThread,
  onRenameThread,
  onArchiveThread,
  onToggleWorkspaceExpanded,
}: SidebarProps) {
  const [expandedThreadLists, setExpandedThreadLists] = useState(
    new Set<string>(),
  );
  const [expandedArchived, setExpandedArchived] = useState(new Set<string>());
  const [renamingThread, setRenamingThread] = useState<{
    workspaceId: string;
    threadId: string;
  } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const totalTokens = usageSnapshot?.totalTokens24h ?? null;
  const totalLabel = totalTokens == null ? "—" : totalTokens.toLocaleString();
  const updatedAtLabel =
    usageSnapshot?.updatedAtMs != null
      ? new Date(usageSnapshot.updatedAtMs).toLocaleTimeString()
      : "—";
  const sourceLabel =
    usageSnapshot?.source === "app-server"
      ? "app-server"
      : usageSnapshot?.source === "sessions"
        ? "sessions"
        : "unknown";
  const rateLimits = usageSnapshot?.rateLimits ?? null;
  const rateLimitsLabel = formatRateLimits(rateLimits);

  function startRename(
    workspaceId: string,
    threadId: string,
    threadName: string,
  ) {
    setRenamingThread({ workspaceId, threadId });
    setRenameValue(threadName);
  }

  function cancelRename() {
    setRenamingThread(null);
    setRenameValue("");
  }

  function commitRename(
    workspaceId: string,
    threadId: string,
    currentName: string,
  ) {
    const trimmed = renameValue.trim();
    cancelRename();
    if (!trimmed || trimmed === currentName) {
      return;
    }
    onRenameThread(workspaceId, threadId, trimmed);
  }

  async function showThreadMenu(
    event: React.MouseEvent,
    workspaceId: string,
    threadId: string,
    threadName: string,
    isArchived: boolean,
  ) {
    event.preventDefault();
    event.stopPropagation();
    const renameItem = await MenuItem.new({
      text: "Rename",
      action: () => {
        startRename(workspaceId, threadId, threadName);
      },
    });
    const archiveItem = await MenuItem.new({
      text: isArchived ? "Unarchive" : "Archive",
      action: () => onArchiveThread(workspaceId, threadId, !isArchived),
    });
    const copyItem = await MenuItem.new({
      text: "Copy ID",
      action: async () => {
        await navigator.clipboard.writeText(threadId);
      },
    });
    const menu = await Menu.new({ items: [renameItem, copyItem, archiveItem] });
    const currentWindow = getCurrentWindow();
    const position = new LogicalPosition(event.clientX, event.clientY);
    await menu.popup(position, currentWindow);
  }

  async function showWorkspaceMenu(
    event: React.MouseEvent,
    workspace: WorkspaceInfo,
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (removingWorkspaceIds.has(workspace.id)) {
      return;
    }
    const removeItem = await MenuItem.new({
      text: "Remove from sidebar",
      action: () => onRemoveWorkspace(workspace),
    });
    const menu = await Menu.new({ items: [removeItem] });
    const currentWindow = getCurrentWindow();
    const position = new LogicalPosition(event.clientX, event.clientY);
    await menu.popup(position, currentWindow);
  }

  return (
    <aside className="sidebar" data-tauri-drag-region>
      <div className="sidebar-header" data-tauri-drag-region>
        <div>
          <div className="subtitle">Workspaces</div>
        </div>
        <button
          className="ghost workspace-add"
          onClick={onAddWorkspace}
          data-tauri-drag-region="false"
          aria-label="Add workspace"
        >
          +
        </button>
      </div>
      <div className="workspace-list">
        {workspaces.map((entry) => {
          const threads = threadsByWorkspace[entry.id] ?? [];
          const activeThreads = threads.filter((thread) => !thread.archived);
          const archivedThreads = threads.filter((thread) => thread.archived);
          const showAllActive = expandedThreadLists.has(entry.id);
          const visibleActive = showAllActive
            ? activeThreads
            : activeThreads.slice(0, 3);
          const archiveExpanded = expandedArchived.has(entry.id);
          const workspaceExpanded = expandedWorkspaceIds[entry.id] ?? true;
          const isRemoving = removingWorkspaceIds.has(entry.id);
          return (
            <div key={entry.id} className="workspace-card">
              <div
                className={`workspace-row ${
                  entry.id === activeWorkspaceId ? "active" : ""
                } ${workspaceExpanded ? "" : "is-collapsed"}${
                  isRemoving ? " is-removing" : ""
                }`}
                role="button"
                tabIndex={0}
                aria-disabled={isRemoving}
                onClick={() => {
                  if (isRemoving) {
                    return;
                  }
                  onToggleWorkspaceExpanded(entry.id);
                }}
                onContextMenu={(event) => showWorkspaceMenu(event, entry)}
                onKeyDown={(event) => {
                  if (isRemoving) {
                    return;
                  }
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onToggleWorkspaceExpanded(entry.id);
                  }
                }}
              >
                <div>
                  <div className="workspace-name-row">
                    <div className="workspace-title">
                      <span className="workspace-name">{entry.name}</span>
                      {isRemoving && (
                        <span className="workspace-status">Removing...</span>
                      )}
                    </div>
                    <button
                      className="ghost workspace-add"
                      disabled={isRemoving}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (isRemoving) {
                          return;
                        }
                        onAddAgent(entry);
                      }}
                      data-tauri-drag-region="false"
                      aria-label="Add agent"
                    >
                      +
                    </button>
                  </div>
                </div>
                {!entry.connected && (
                  <span
                    className={`connect${isRemoving ? " is-disabled" : ""}`}
                    data-tauri-drag-region="false"
                    onClick={(event) => {
                      event.stopPropagation();
                      if (isRemoving) {
                        return;
                      }
                      onConnectWorkspace(entry);
                    }}
                  >
                    connect
                  </span>
                )}
              </div>
              {workspaceExpanded && activeThreads.length > 0 && (
                <div className="thread-list">
                  {visibleActive.map((thread) => {
                    const isRenaming =
                      renamingThread?.workspaceId === entry.id &&
                      renamingThread?.threadId === thread.id;
                    return (
                      <div
                        key={thread.id}
                        className={`thread-row ${
                          thread.archived ? "archived" : ""
                        } ${
                          entry.id === activeWorkspaceId &&
                          thread.id === activeThreadId
                            ? "active"
                            : ""
                        }`}
                        onClick={() => onSelectThread(entry.id, thread.id)}
                        onContextMenu={(event) =>
                          showThreadMenu(
                            event,
                            entry.id,
                            thread.id,
                            thread.name,
                            Boolean(thread.archived),
                          )
                        }
                        role="button"
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onSelectThread(entry.id, thread.id);
                          }
                        }}
                      >
                        <span
                          className={`thread-status ${
                            threadStatusById[thread.id]?.isReviewing
                              ? "reviewing"
                              : threadStatusById[thread.id]?.isProcessing
                                ? "processing"
                                : threadStatusById[thread.id]?.hasUnread
                                  ? "unread"
                                  : "ready"
                          }`}
                          aria-hidden
                        />
                        {isRenaming ? (
                          <input
                            className="thread-name-input"
                            value={renameValue}
                            onChange={(event) =>
                              setRenameValue(event.target.value)
                            }
                            onBlur={() =>
                              commitRename(entry.id, thread.id, thread.name)
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                commitRename(
                                  entry.id,
                                  thread.id,
                                  thread.name,
                                );
                              } else if (event.key === "Escape") {
                                event.preventDefault();
                                cancelRename();
                              }
                            }}
                            onClick={(event) => event.stopPropagation()}
                            onMouseDown={(event) => event.stopPropagation()}
                            autoFocus
                            spellCheck={false}
                          />
                        ) : (
                          <span className="thread-name">{thread.name}</span>
                        )}
                        <div className="thread-menu">
                          <button
                            className="thread-menu-trigger"
                            aria-label="Thread menu"
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={(event) =>
                              showThreadMenu(
                                event,
                                entry.id,
                                thread.id,
                                thread.name,
                                Boolean(thread.archived),
                              )
                            }
                          >
                            ...
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {activeThreads.length > 3 && (
                    <button
                      className="thread-more"
                      onClick={(event) => {
                        event.stopPropagation();
                        setExpandedThreadLists((prev) => {
                          const next = new Set(prev);
                          if (next.has(entry.id)) {
                            next.delete(entry.id);
                          } else {
                            next.add(entry.id);
                          }
                          return next;
                        });
                      }}
                    >
                      {showAllActive
                        ? "Show less"
                        : `${activeThreads.length - 3} more...`}
                    </button>
                  )}
                </div>
              )}
              {workspaceExpanded && archivedThreads.length > 0 && (
                <div className="thread-section">
                  <button
                    className="thread-section-toggle"
                    onClick={(event) => {
                      event.stopPropagation();
                      setExpandedArchived((prev) => {
                        const next = new Set(prev);
                        if (next.has(entry.id)) {
                          next.delete(entry.id);
                        } else {
                          next.add(entry.id);
                        }
                        return next;
                      });
                    }}
                  >
                    <span className="thread-section-chevron">
                      {archiveExpanded ? "v" : ">"}
                    </span>
                    {`Archived (${archivedThreads.length})`}
                  </button>
                  {archiveExpanded && (
                    <div className="thread-list">
                      {archivedThreads.map((thread) => {
                        const isRenaming =
                          renamingThread?.workspaceId === entry.id &&
                          renamingThread?.threadId === thread.id;
                        return (
                          <div
                            key={thread.id}
                            className={`thread-row archived ${
                              entry.id === activeWorkspaceId &&
                              thread.id === activeThreadId
                                ? "active"
                                : ""
                            }`}
                            onClick={() => onSelectThread(entry.id, thread.id)}
                            onContextMenu={(event) =>
                              showThreadMenu(
                                event,
                                entry.id,
                                thread.id,
                                thread.name,
                                Boolean(thread.archived),
                              )
                            }
                            role="button"
                            tabIndex={0}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                onSelectThread(entry.id, thread.id);
                              }
                            }}
                          >
                            <span
                              className={`thread-status ${
                                threadStatusById[thread.id]?.isReviewing
                                  ? "reviewing"
                                  : threadStatusById[thread.id]?.isProcessing
                                    ? "processing"
                                    : threadStatusById[thread.id]?.hasUnread
                                      ? "unread"
                                      : "ready"
                              }`}
                              aria-hidden
                            />
                            {isRenaming ? (
                              <input
                                className="thread-name-input"
                                value={renameValue}
                                onChange={(event) =>
                                  setRenameValue(event.target.value)
                                }
                                onBlur={() =>
                                  commitRename(
                                    entry.id,
                                    thread.id,
                                    thread.name,
                                  )
                                }
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    commitRename(
                                      entry.id,
                                      thread.id,
                                      thread.name,
                                    );
                                  } else if (event.key === "Escape") {
                                    event.preventDefault();
                                    cancelRename();
                                  }
                                }}
                                onClick={(event) => event.stopPropagation()}
                                onMouseDown={(event) => event.stopPropagation()}
                                autoFocus
                                spellCheck={false}
                              />
                            ) : (
                              <span className="thread-name">{thread.name}</span>
                            )}
                            <div className="thread-menu">
                              <button
                                className="thread-menu-trigger"
                                aria-label="Thread menu"
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={(event) =>
                                  showThreadMenu(
                                    event,
                                    entry.id,
                                    thread.id,
                                    thread.name,
                                    Boolean(thread.archived),
                                  )
                                }
                              >
                                ...
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!workspaces.length && (
          <div className="empty">Add a workspace to start.</div>
        )}
      </div>
      <div className="sidebar-footer" data-tauri-drag-region="false">
        <div className="sidebar-footer-label">24h tokens</div>
        <div className="sidebar-footer-value">{totalLabel}</div>
        {rateLimitsLabel && (
          <div className="sidebar-footer-limits">{rateLimitsLabel}</div>
        )}
        <div className="sidebar-footer-meta">
          {`Source: ${sourceLabel}`}
          {updatedAtLabel !== "—" ? ` · Updated: ${updatedAtLabel}` : ""}
        </div>
      </div>
    </aside>
  );
}

function formatRateLimits(snapshot: RateLimitSnapshot | null): string | null {
  if (!snapshot?.primary && !snapshot?.secondary) {
    return null;
  }
  const primary = snapshot.primary
    ? `5h ${Math.round(snapshot.primary.usedPercent)}%`
    : "5h —";
  const secondary = snapshot.secondary
    ? `7d ${Math.round(snapshot.secondary.usedPercent)}%`
    : "7d —";
  return `Limits: ${primary} · ${secondary}`;
}
