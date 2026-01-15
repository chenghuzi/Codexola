import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { listen } from "@tauri-apps/api/event";
import "./styles/base.css";
import "./styles/buttons.css";
import "./styles/sidebar.css";
import "./styles/home.css";
import "./styles/main.css";
import "./styles/messages.css";
import "./styles/approvals.css";
import "./styles/composer.css";
import "./styles/diff.css";
import "./styles/diff-viewer.css";
import "./styles/debug.css";
import "./styles/settings.css";
import "./styles/confirm-quit.css";
import "./styles/codex-path.css";
import { Sidebar } from "./components/Sidebar";
import { Home } from "./components/Home";
import { MainHeader } from "./components/MainHeader";
import { Messages } from "./components/Messages";
import { Approvals } from "./components/Approvals";
import { Composer } from "./components/Composer";
import { GitDiffPanel } from "./components/GitDiffPanel";
import { GitDiffViewer } from "./components/GitDiffViewer";
import { DebugPanel } from "./components/DebugPanel";
import { ConfirmQuitModal } from "./components/ConfirmQuitModal";
import { CodexPathModal } from "./components/CodexPathModal";
import { useWorkspaces } from "./hooks/useWorkspaces";
import { useThreads } from "./hooks/useThreads";
import { useGitStatus } from "./hooks/useGitStatus";
import { useGitDiffs } from "./hooks/useGitDiffs";
import { useModels } from "./hooks/useModels";
import { useSkills } from "./hooks/useSkills";
import { usePrompts } from "./hooks/usePrompts";
import { useFileSearch } from "./hooks/useFileSearch";
import { useDebugLog } from "./hooks/useDebugLog";
import { useWorkspaceRefreshOnFocus } from "./hooks/useWorkspaceRefreshOnFocus";
import { useWorkspaceRestore } from "./hooks/useWorkspaceRestore";
import { Settings } from "./components/Settings";
import { useSettings } from "./hooks/useSettings";
import { useUsage } from "./hooks/useUsage";
import {
  confirmQuit,
  pickCodexBinPath,
  pickNodeBinPath,
  inspectCodexBin,
  readPrompt,
  saveAttachment,
  validateCodexBin,
} from "./services/tauri";
import { buildPromptSlashItems } from "./utils/slash";
import { expandPromptTemplate, parsePromptInvocation } from "./utils/prompts";
import type { AccessMode, ComposerAttachment, UsageSnapshot } from "./types";

type MainAppProps = {
  accessMode: AccessMode;
  onAccessModeChange: (mode: AccessMode) => void;
  sidebarWidth: number;
  onSidebarWidthChange: (width: number) => void;
  enableCompletionNotifications: boolean;
  usageSnapshot: UsageSnapshot | null;
  workspaceSidebarExpanded: Record<string, boolean>;
  onWorkspaceSidebarExpandedChange: (next: Record<string, boolean>) => void;
  onRequireCodexBin: (message: string) => void;
};

const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;

function clampSidebarWidth(value: number) {
  return Math.min(
    SIDEBAR_MAX_WIDTH,
    Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)),
  );
}

function MainApp({
  accessMode,
  onAccessModeChange,
  sidebarWidth: persistedSidebarWidth,
  onSidebarWidthChange,
  enableCompletionNotifications,
  usageSnapshot,
  workspaceSidebarExpanded,
  onWorkspaceSidebarExpandedChange,
  onRequireCodexBin,
}: MainAppProps) {
  const [centerMode, setCenterMode] = useState<"chat" | "diff">("chat");
  const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null);
  const [isConfirmQuitOpen, setIsConfirmQuitOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    clampSidebarWidth(persistedSidebarWidth),
  );
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const sidebarDragRef = useRef<{ startX: number; startWidth: number } | null>(
    null,
  );
  const {
    debugOpen,
    setDebugOpen,
    debugEntries,
    hasDebugAlerts,
    addDebugEntry,
    handleCopyDebug,
    clearDebugEntries,
  } = useDebugLog();

  const {
    workspaces,
    activeWorkspace,
    activeWorkspaceId,
    setActiveWorkspaceId,
    addWorkspace,
    connectWorkspace,
    markWorkspaceConnected,
    hasLoaded,
    refreshWorkspaces,
  } = useWorkspaces({
    onDebug: addDebugEntry,
    onCodexBinMissing: onRequireCodexBin,
  });

  const { status: gitStatus, refresh: refreshGitStatus } =
    useGitStatus(activeWorkspace);
  const {
    diffs: gitDiffs,
    isLoading: isDiffLoading,
    error: diffError,
  } = useGitDiffs(activeWorkspace, gitStatus.files, centerMode === "diff");
  const {
    models,
    selectedModel,
    selectedModelId,
    setSelectedModelId,
    reasoningOptions,
    selectedEffort,
    setSelectedEffort,
  } = useModels({ activeWorkspace, onDebug: addDebugEntry });
  const { skills } = useSkills({ activeWorkspace, onDebug: addDebugEntry });
  const { prompts } = usePrompts({ onDebug: addDebugEntry });
  const slashItems = useMemo(() => buildPromptSlashItems(prompts), [prompts]);
  const [atQuery, setAtQuery] = useState<string | null>(null);
  const { items: fileMatches } = useFileSearch({
    workspaceId: activeWorkspaceId,
    query: atQuery,
    onDebug: addDebugEntry,
  });
  const fileItems = useMemo(
    () =>
      fileMatches.map((path) => {
        const normalized = path.replace(/\\/g, "/");
        const parts = normalized.split("/");
        const title = parts.pop() ?? normalized;
        const description = parts.length > 0 ? parts.join("/") : undefined;
        return {
          id: `file:${normalized}`,
          kind: "file" as const,
          title,
          description,
          insertText: `@${normalized} `,
        };
      }),
    [fileMatches],
  );

  const resolvedModel = selectedModel?.model ?? null;
  const fileStatus =
    gitStatus.files.length > 0
      ? `${gitStatus.files.length} file${gitStatus.files.length === 1 ? "" : "s"} changed`
      : "Working tree clean";

  const openThreadRef = useRef<
    (workspaceId: string, threadId: string) => void
  >(() => {});

  const {
    setActiveThreadId,
    activeThreadId,
    activeItems,
    approvals,
    threadsByWorkspace,
    threadStatusById,
    renameThread,
    setThreadArchived,
    startThreadForWorkspace,
    listThreadsForWorkspace,
    sendUserMessage,
    startReview,
    handleApprovalDecision,
  } = useThreads({
    activeWorkspace,
    onWorkspaceConnected: markWorkspaceConnected,
    onDebug: addDebugEntry,
    model: resolvedModel,
    effort: selectedEffort,
    accessMode,
    onMessageActivity: refreshGitStatus,
    notifications: {
      enabled: enableCompletionNotifications,
      workspaces,
      onOpenThread: (workspaceId, threadId) => {
        openThreadRef.current(workspaceId, threadId);
      },
    },
  });

  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [pendingAttachmentCount, setPendingAttachmentCount] = useState(0);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const activeWorkspaceIdRef = useRef<string | null>(null);
  const activeThreadIdRef = useRef<string | null>(null);
  const appStyle = useMemo(
    () =>
      ({
        "--sidebar-width": `${sidebarWidth}px`,
        userSelect: isResizingSidebar ? "none" : undefined,
        cursor: isResizingSidebar ? "col-resize" : undefined,
      }) as CSSProperties,
    [sidebarWidth, isResizingSidebar],
  );
  const expandedWorkspaceIds = workspaceSidebarExpanded ?? {};

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    activeWorkspaceIdRef.current = activeWorkspaceId ?? null;
    activeThreadIdRef.current = activeThreadId ?? null;
  }, [activeWorkspaceId, activeThreadId]);

  useEffect(() => {
    if (!isResizingSidebar) {
      setSidebarWidth(clampSidebarWidth(persistedSidebarWidth));
    }
  }, [isResizingSidebar, persistedSidebarWidth]);

  const clearAttachments = useCallback(() => {
    setAttachments((prev) => {
      prev.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
      return [];
    });
  }, []);

  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach((attachment) => {
        URL.revokeObjectURL(attachment.previewUrl);
      });
    };
  }, []);

  useEffect(() => {
    const subscription = listen("confirm-quit", () => {
      setIsConfirmQuitOpen(true);
    });
    return () => {
      subscription.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (!isConfirmQuitOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsConfirmQuitOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isConfirmQuitOpen]);

  useEffect(() => {
    clearAttachments();
  }, [activeWorkspaceId, activeThreadId, clearAttachments]);

  const handleAddAttachments = useCallback(
    async (files: File[]) => {
      if (!activeWorkspace || files.length === 0) {
        return;
      }
      const images = files.filter((file) => file.type.startsWith("image/"));
      if (images.length === 0) {
        return;
      }
      const workspaceId = activeWorkspace.id;
      const threadId = activeThreadId ?? null;
      setPendingAttachmentCount((prev) => prev + images.length);
      const created: ComposerAttachment[] = [];

      for (const file of images) {
        try {
          const buffer = await file.arrayBuffer();
          const bytes = Array.from(new Uint8Array(buffer));
          const result = await saveAttachment(workspaceId, {
            bytes,
            name: file.name,
            mime: file.type,
          });
          const previewUrl = URL.createObjectURL(file);
          const id =
            typeof crypto !== "undefined" && "randomUUID" in crypto
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
          if (
            activeWorkspaceIdRef.current !== workspaceId ||
            activeThreadIdRef.current !== threadId
          ) {
            URL.revokeObjectURL(previewUrl);
            continue;
          }
          created.push({
            id,
            name: file.name || "image",
            size: file.size,
            mime: file.type || "image",
            path: result.path,
            previewUrl,
          });
        } catch (error) {
          addDebugEntry({
            id: `${Date.now()}-attachment-save-error`,
            timestamp: Date.now(),
            source: "error",
            label: "attachment save error",
            payload: error instanceof Error ? error.message : String(error),
          });
        } finally {
          setPendingAttachmentCount((prev) => Math.max(0, prev - 1));
        }
      }

      if (created.length > 0) {
        setAttachments((prev) => [...prev, ...created]);
      }
    },
    [activeWorkspace, activeThreadId, addDebugEntry],
  );

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const next = prev.filter((attachment) => attachment.id !== id);
      const removed = prev.find((attachment) => attachment.id === id);
      if (removed) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      return next;
    });
  }, []);

  useWorkspaceRestore({
    workspaces,
    hasLoaded,
    connectWorkspace,
    listThreadsForWorkspace,
  });
  useWorkspaceRefreshOnFocus({
    workspaces,
    refreshWorkspaces,
    listThreadsForWorkspace,
  });

  async function handleAddWorkspace() {
    const workspace = await addWorkspace();
    if (workspace) {
      setActiveThreadId(null, workspace.id);
    }
  }

  function exitDiffView() {
    setCenterMode("chat");
    setSelectedDiffPath(null);
  }

  const handleSelectThread = useCallback(
    (workspaceId: string, threadId: string) => {
      setCenterMode("chat");
      setSelectedDiffPath(null);
      setActiveWorkspaceId(workspaceId);
      setActiveThreadId(threadId, workspaceId);
    },
    [setActiveThreadId, setActiveWorkspaceId],
  );

  openThreadRef.current = handleSelectThread;

  const handleToggleWorkspaceExpanded = useCallback(
    (workspaceId: string) => {
      const current = expandedWorkspaceIds[workspaceId];
      const next = {
        ...expandedWorkspaceIds,
        [workspaceId]: !(current ?? true),
      };
      onWorkspaceSidebarExpandedChange(next);
    },
    [expandedWorkspaceIds, onWorkspaceSidebarExpandedChange],
  );

  async function handleAddAgent(workspace: (typeof workspaces)[number]) {
    exitDiffView();
    setActiveWorkspaceId(workspace.id);
    if (!workspace.connected) {
      await connectWorkspace(workspace);
    }
    await startThreadForWorkspace(workspace.id);
  }

  function handleSelectDiff(path: string) {
    setSelectedDiffPath(path);
    setCenterMode("diff");
  }

  async function handleSend(text: string, nextAttachments: ComposerAttachment[]) {
    const trimmed = text.trim();
    const hasAttachments = nextAttachments.length > 0;
    if (!trimmed && !hasAttachments) {
      return;
    }
    if (pendingAttachmentCount > 0) {
      return;
    }
    if (activeThreadId && threadStatusById[activeThreadId]?.isReviewing) {
      return;
    }
    if (activeWorkspace && !activeWorkspace.connected) {
      await connectWorkspace(activeWorkspace);
    }
    if (trimmed.startsWith("/review")) {
      await startReview(trimmed);
      return;
    }
    let messageText = trimmed;
    const invocation = parsePromptInvocation(messageText);
    if (invocation) {
      try {
        const promptFile = await readPrompt(invocation.name);
        messageText = expandPromptTemplate(promptFile.body, invocation);
      } catch (error) {
        addDebugEntry({
          id: `${Date.now()}-prompt-expand-error`,
          timestamp: Date.now(),
          source: "error",
          label: "prompt/expand error",
          payload: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await sendUserMessage(
      messageText,
      nextAttachments.map((attachment) => ({ path: attachment.path })),
    );
    clearAttachments();
  }

  const handleConfirmQuit = useCallback(async () => {
    setIsConfirmQuitOpen(false);
    try {
      await confirmQuit();
    } catch (error) {
      addDebugEntry({
        id: `${Date.now()}-confirm-quit-error`,
        timestamp: Date.now(),
        source: "error",
        label: "confirm quit error",
        payload: error instanceof Error ? error.message : String(error),
      });
    }
  }, [addDebugEntry]);

  const commitSidebarWidth = useCallback(
    (value: number) => {
      const nextWidth = clampSidebarWidth(value);
      if (nextWidth !== persistedSidebarWidth) {
        onSidebarWidthChange(nextWidth);
      }
    },
    [onSidebarWidthChange, persistedSidebarWidth],
  );

  const handleSidebarResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      sidebarDragRef.current = {
        startX: event.clientX,
        startWidth: sidebarWidth,
      };
      setIsResizingSidebar(true);
    },
    [sidebarWidth],
  );

  const handleSidebarResizeMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isResizingSidebar || !sidebarDragRef.current) {
        return;
      }
      const delta = event.clientX - sidebarDragRef.current.startX;
      const nextWidth = clampSidebarWidth(
        sidebarDragRef.current.startWidth + delta,
      );
      setSidebarWidth(nextWidth);
    },
    [isResizingSidebar],
  );

  const handleSidebarResizeEnd = useCallback(() => {
    if (!isResizingSidebar) {
      return;
    }
    setIsResizingSidebar(false);
    sidebarDragRef.current = null;
    commitSidebarWidth(sidebarWidth);
  }, [commitSidebarWidth, isResizingSidebar, sidebarWidth]);

  return (
    <div
      className={`app${isResizingSidebar ? " is-resizing" : ""}`}
      style={appStyle}
    >
      <Sidebar
        workspaces={workspaces}
        threadsByWorkspace={threadsByWorkspace}
        threadStatusById={threadStatusById}
        usageSnapshot={usageSnapshot}
        activeWorkspaceId={activeWorkspaceId}
        activeThreadId={activeThreadId}
        expandedWorkspaceIds={expandedWorkspaceIds}
        onToggleWorkspaceExpanded={handleToggleWorkspaceExpanded}
        onAddWorkspace={handleAddWorkspace}
        onConnectWorkspace={connectWorkspace}
        onAddAgent={handleAddAgent}
        onSelectThread={handleSelectThread}
        onRenameThread={(workspaceId, threadId, name) => {
          void renameThread(workspaceId, threadId, name);
        }}
        onArchiveThread={(workspaceId, threadId, archived) => {
          void setThreadArchived(workspaceId, threadId, archived);
        }}
      />
      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={sidebarWidth}
        onPointerDown={handleSidebarResizeStart}
        onPointerMove={handleSidebarResizeMove}
        onPointerUp={handleSidebarResizeEnd}
        onPointerCancel={handleSidebarResizeEnd}
        data-tauri-drag-region="false"
      />

      <section className="main">
        {!activeWorkspace && (
          <Home
            onOpenProject={handleAddWorkspace}
            onAddWorkspace={handleAddWorkspace}
            onCloneRepository={() => {}}
          />
        )}

        {activeWorkspace && (
          <>
            <div className="main-topbar" data-tauri-drag-region>
              <div className="main-topbar-left">
                {centerMode === "diff" && (
                  <button
                    className="ghost icon-button"
                    data-tauri-drag-region="false"
                    onClick={() => {
                      setCenterMode("chat");
                      setSelectedDiffPath(null);
                    }}
                    aria-label="Back to chat"
                  >
                    <span aria-hidden>‹</span>
                  </button>
                )}
                <MainHeader
                  workspace={activeWorkspace}
                  branchName={gitStatus.branchName || "unknown"}
                />
              </div>
              <div className="actions">
                {hasDebugAlerts && (
                  <button
                    className="ghost icon-button"
                    data-tauri-drag-region="false"
                    onClick={() => setDebugOpen((prev) => !prev)}
                    aria-label="Debug"
                  >
                    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
                      <path
                        d="M9 7.5V6.5a3 3 0 0 1 6 0v1"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                      />
                      <rect
                        x="7"
                        y="7.5"
                        width="10"
                        height="9"
                        rx="3"
                        stroke="currentColor"
                        strokeWidth="1.4"
                      />
                      <path
                        d="M4 12h3m10 0h3M6 8l2 2m8-2-2 2M6 16l2-2m8 2-2-2"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                      />
                      <circle cx="10" cy="12" r="0.8" fill="currentColor" />
                      <circle cx="14" cy="12" r="0.8" fill="currentColor" />
                    </svg>
                  </button>
                )}
              </div>
            </div>

            <div className="content">
              {centerMode === "diff" ? (
                <GitDiffViewer
                  diffs={gitDiffs}
                  selectedPath={selectedDiffPath}
                  isLoading={isDiffLoading}
                  error={diffError}
                />
              ) : (
                <Messages
                  items={activeItems}
                  isThinking={
                    activeThreadId
                      ? threadStatusById[activeThreadId]?.isProcessing ?? false
                      : false
                  }
                />
              )}
            </div>

            <div className="right-panel">
              <GitDiffPanel
                branchName={gitStatus.branchName || "unknown"}
                totalAdditions={gitStatus.totalAdditions}
                totalDeletions={gitStatus.totalDeletions}
                fileStatus={fileStatus}
                error={gitStatus.error}
                files={gitStatus.files}
                selectedPath={selectedDiffPath}
                onSelectFile={handleSelectDiff}
              />
              <Approvals approvals={approvals} onDecision={handleApprovalDecision} />
            </div>

            {centerMode === "chat" && (
              <Composer
                onSend={handleSend}
                disabled={
                  activeThreadId
                    ? threadStatusById[activeThreadId]?.isReviewing ?? false
                    : false
                }
                isSavingAttachments={pendingAttachmentCount > 0}
                attachments={attachments}
                onAddAttachments={handleAddAttachments}
                onRemoveAttachment={handleRemoveAttachment}
                models={models}
                selectedModelId={selectedModelId}
                onSelectModel={setSelectedModelId}
                reasoningOptions={reasoningOptions}
                selectedEffort={selectedEffort}
                onSelectEffort={setSelectedEffort}
                accessMode={accessMode}
                onSelectAccessMode={onAccessModeChange}
                skills={skills}
                slashItems={slashItems}
                fileItems={fileItems}
                onAtQueryChange={setAtQuery}
              />
            )}
            <DebugPanel
              entries={debugEntries}
              isOpen={debugOpen}
              onClear={clearDebugEntries}
              onCopy={handleCopyDebug}
            />
          </>
        )}
      </section>
      <ConfirmQuitModal
        isOpen={isConfirmQuitOpen}
        onCancel={() => setIsConfirmQuitOpen(false)}
        onConfirm={handleConfirmQuit}
      />
    </div>
  );
}

export default App;

function App() {
  const [route, setRoute] = useState(() => window.location.hash);
  const { settings, updateSettings, isLoaded } = useSettings();
  const { snapshot: usageSnapshot } = useUsage(settings);
  const [codexModalOpen, setCodexModalOpen] = useState(false);
  const [codexModalForced, setCodexModalForced] = useState(false);
  const [codexPathDraft, setCodexPathDraft] = useState("");
  const [nodePathDraft, setNodePathDraft] = useState("");
  const [codexRequiresNode, setCodexRequiresNode] = useState(false);
  const [codexTestStatus, setCodexTestStatus] = useState<
    "idle" | "testing" | "success" | "error"
  >("idle");
  const [codexTestMessage, setCodexTestMessage] = useState<string | null>(null);
  const codexInspectRef = useRef(0);
  const codexValidationRef = useRef(0);

  const openCodexModal = useCallback(
    (forced: boolean) => {
      setCodexModalOpen(true);
      setCodexModalForced(forced);
      setCodexPathDraft(settings.codexBinPath ?? "");
      setNodePathDraft(settings.nodeBinPath ?? "");
      setCodexRequiresNode(false);
      setCodexTestStatus("idle");
      setCodexTestMessage(null);
    },
    [settings.codexBinPath, settings.nodeBinPath],
  );

  const handleRequireCodexBin = useCallback(
    (_message: string) => {
      openCodexModal(true);
    },
    [openCodexModal],
  );

  useEffect(() => {
    const handleHashChange = () => setRoute(window.location.hash);
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  useEffect(() => {
    if (!isLoaded) {
      return;
    }
    const hasPath = Boolean(settings.codexBinPath?.trim());
    if (!hasPath) {
      setCodexModalForced(true);
      setCodexModalOpen(true);
      setCodexPathDraft(settings.codexBinPath ?? "");
      setNodePathDraft(settings.nodeBinPath ?? "");
      setCodexRequiresNode(false);
      setCodexTestStatus("idle");
      setCodexTestMessage(null);
      return;
    }
    if (codexModalForced) {
      setCodexModalForced(false);
      setCodexModalOpen(false);
    }
  }, [codexModalForced, isLoaded, settings.codexBinPath]);

  const normalizePath = useCallback(
    (value: string) => value.trim().replace(/^["']|["']$/g, ""),
    [],
  );

  const handleCodexPathChange = useCallback((value: string) => {
    setCodexPathDraft(value);
    setCodexTestStatus("idle");
    setCodexTestMessage(null);
  }, []);

  const handleNodePathChange = useCallback((value: string) => {
    setNodePathDraft(value);
    setCodexTestStatus("idle");
    setCodexTestMessage(null);
  }, []);

  const handleCodexBrowse = useCallback(async () => {
    const selection = await pickCodexBinPath();
    if (!selection) {
      return;
    }
    setCodexPathDraft(selection);
    setCodexTestStatus("idle");
    setCodexTestMessage(null);
  }, []);

  const handleNodeBrowse = useCallback(async () => {
    const selection = await pickNodeBinPath();
    if (!selection) {
      return;
    }
    setNodePathDraft(selection);
    setCodexTestStatus("idle");
    setCodexTestMessage(null);
  }, []);

  const runCodexValidation = useCallback(
    async (requestId?: number) => {
      const codexPath = normalizePath(codexPathDraft);
      const nodePath = normalizePath(nodePathDraft);
      if (!codexPath) {
        setCodexTestStatus("error");
        setCodexTestMessage("Codex binary path is required.");
        return false;
      }
      if (codexRequiresNode && !nodePath) {
        setCodexTestStatus("error");
        setCodexTestMessage("Node binary path is required.");
        return false;
      }
      setCodexTestStatus("testing");
      setCodexTestMessage(null);
      try {
        await validateCodexBin(codexPath);
        if (codexRequiresNode) {
          await validateCodexBin(nodePath);
        }
        if (requestId && requestId !== codexValidationRef.current) {
          return false;
        }
        setCodexTestStatus("success");
        setCodexTestMessage("Validation passed.");
        return true;
      } catch (error) {
        if (requestId && requestId !== codexValidationRef.current) {
          return false;
        }
        setCodexTestStatus("error");
        setCodexTestMessage(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [codexPathDraft, nodePathDraft, codexRequiresNode, normalizePath],
  );

  const handleCodexTest = useCallback(async () => {
    codexValidationRef.current += 1;
    const requestId = codexValidationRef.current;
    await runCodexValidation(requestId);
  }, [runCodexValidation]);

  const handleCodexSave = useCallback(() => {
    const normalizedCodex = normalizePath(codexPathDraft);
    const normalizedNode = normalizePath(nodePathDraft);
    if (!normalizedCodex || codexTestStatus !== "success") {
      return;
    }
    updateSettings({
      codexBinPath: normalizedCodex,
      nodeBinPath: codexRequiresNode
        ? normalizedNode
        : settings.nodeBinPath ?? null,
    });
    setCodexPathDraft(normalizedCodex);
    setNodePathDraft(
      codexRequiresNode ? normalizedNode : settings.nodeBinPath ?? "",
    );
    setCodexModalOpen(false);
    setCodexModalForced(false);
  }, [
    codexPathDraft,
    nodePathDraft,
    codexRequiresNode,
    codexTestStatus,
    normalizePath,
    settings.nodeBinPath,
    updateSettings,
  ]);

  const canSaveCodexPath =
    codexTestStatus === "success" && codexPathDraft.trim().length > 0;

  useEffect(() => {
    if (!codexModalOpen) {
      return;
    }
    const normalizedCodex = normalizePath(codexPathDraft);
    if (!normalizedCodex) {
      setCodexRequiresNode(false);
      return;
    }
    codexInspectRef.current += 1;
    const requestId = codexInspectRef.current;
    inspectCodexBin(normalizedCodex)
      .then((result) => {
        if (requestId !== codexInspectRef.current) {
          return;
        }
        setCodexRequiresNode(result.requiresNode);
        if (result.requiresNode && result.suggestedNodePath) {
          setNodePathDraft((prev) =>
            prev.trim() ? prev : result.suggestedNodePath ?? "",
          );
        }
      })
      .catch(() => {
        if (requestId !== codexInspectRef.current) {
          return;
        }
        setCodexRequiresNode(false);
      });
  }, [codexModalOpen, codexPathDraft, normalizePath]);

  useEffect(() => {
    if (!codexModalOpen) {
      return;
    }
    const normalizedCodex = normalizePath(codexPathDraft);
    const normalizedNode = normalizePath(nodePathDraft);
    if (!normalizedCodex) {
      setCodexTestStatus("idle");
      setCodexTestMessage(null);
      return;
    }
    if (codexRequiresNode && !normalizedNode) {
      setCodexTestStatus("error");
      setCodexTestMessage("Node binary path is required.");
      return;
    }
    codexValidationRef.current += 1;
    const requestId = codexValidationRef.current;
    const timer = window.setTimeout(() => {
      void runCodexValidation(requestId);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [
    codexModalOpen,
    codexPathDraft,
    nodePathDraft,
    codexRequiresNode,
    normalizePath,
    runCodexValidation,
  ]);

  const content = route.startsWith("#/settings") ? (
    <Settings
      settings={settings}
      onUpdateSettings={updateSettings}
      onOpenCodexPathModal={() => openCodexModal(false)}
    />
  ) : (
    <MainApp
      accessMode={settings.accessMode}
      onAccessModeChange={(mode) => updateSettings({ accessMode: mode })}
      sidebarWidth={settings.sidebarWidth}
      onSidebarWidthChange={(width) => updateSettings({ sidebarWidth: width })}
      enableCompletionNotifications={settings.enableCompletionNotifications}
      usageSnapshot={usageSnapshot}
      workspaceSidebarExpanded={settings.workspaceSidebarExpanded}
      onWorkspaceSidebarExpandedChange={(next) =>
        updateSettings({ workspaceSidebarExpanded: next })
      }
      onRequireCodexBin={handleRequireCodexBin}
    />
  );

  return (
    <>
      {content}
      <CodexPathModal
        isOpen={codexModalOpen}
        path={codexPathDraft}
        nodePath={nodePathDraft}
        requiresNode={codexRequiresNode}
        testStatus={codexTestStatus}
        testMessage={codexTestMessage}
        canSave={canSaveCodexPath}
        onChangePath={handleCodexPathChange}
        onChangeNodePath={handleNodePathChange}
        onBrowse={handleCodexBrowse}
        onBrowseNode={handleNodeBrowse}
        onTest={handleCodexTest}
        onSave={handleCodexSave}
        onCancel={
          codexModalForced ? undefined : () => setCodexModalOpen(false)
        }
      />
    </>
  );
}
