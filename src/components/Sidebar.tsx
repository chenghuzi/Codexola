import type { ThreadSummary, WorkspaceInfo } from "../types";
import { useState } from "react";
import { Menu, MenuItem } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";

type SidebarProps = {
  workspaces: WorkspaceInfo[];
  threadsByWorkspace: Record<string, ThreadSummary[]>;
  threadStatusById: Record<
    string,
    { isProcessing: boolean; hasUnread: boolean; isReviewing: boolean }
  >;
  activeWorkspaceId: string | null;
  activeThreadId: string | null;
  onAddWorkspace: () => void;
  onSelectWorkspace: (id: string) => void;
  onConnectWorkspace: (workspace: WorkspaceInfo) => void;
  onAddAgent: (workspace: WorkspaceInfo) => void;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onRenameThread: (workspaceId: string, threadId: string, name: string) => void;
  onArchiveThread: (
    workspaceId: string,
    threadId: string,
    archived: boolean,
  ) => void;
};

export function Sidebar({
  workspaces,
  threadsByWorkspace,
  threadStatusById,
  activeWorkspaceId,
  activeThreadId,
  onAddWorkspace,
  onSelectWorkspace,
  onConnectWorkspace,
  onAddAgent,
  onSelectThread,
  onRenameThread,
  onArchiveThread,
}: SidebarProps) {
  const [expandedWorkspaces, setExpandedWorkspaces] = useState(
    new Set<string>(),
  );
  const [expandedArchived, setExpandedArchived] = useState(new Set<string>());
  const [renamingThread, setRenamingThread] = useState<{
    workspaceId: string;
    threadId: string;
  } | null>(null);
  const [renameValue, setRenameValue] = useState("");

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
          const showAllActive = expandedWorkspaces.has(entry.id);
          const visibleActive = showAllActive
            ? activeThreads
            : activeThreads.slice(0, 3);
          const archiveExpanded = expandedArchived.has(entry.id);
          return (
            <div key={entry.id} className="workspace-card">
              <div
                className={`workspace-row ${
                  entry.id === activeWorkspaceId ? "active" : ""
                }`}
                role="button"
                tabIndex={0}
                onClick={() => onSelectWorkspace(entry.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelectWorkspace(entry.id);
                  }
                }}
              >
                <div>
                  <div className="workspace-name-row">
                    <span className="workspace-name">{entry.name}</span>
                    <button
                      className="ghost workspace-add"
                      onClick={(event) => {
                        event.stopPropagation();
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
                    className="connect"
                    data-tauri-drag-region="false"
                    onClick={(event) => {
                      event.stopPropagation();
                      onConnectWorkspace(entry);
                    }}
                  >
                    connect
                  </span>
                )}
              </div>
              {activeThreads.length > 0 && (
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
                        setExpandedWorkspaces((prev) => {
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
              {archivedThreads.length > 0 && (
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
    </aside>
  );
}
