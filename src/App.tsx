import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useWorkspaces } from "./hooks/useWorkspaces";
import { useThreads } from "./hooks/useThreads";
import { useGitStatus } from "./hooks/useGitStatus";
import { useGitDiffs } from "./hooks/useGitDiffs";
import { useModels } from "./hooks/useModels";
import { useSkills } from "./hooks/useSkills";
import { usePrompts } from "./hooks/usePrompts";
import { useDebugLog } from "./hooks/useDebugLog";
import { useWorkspaceRefreshOnFocus } from "./hooks/useWorkspaceRefreshOnFocus";
import { useWorkspaceRestore } from "./hooks/useWorkspaceRestore";
import { Settings } from "./components/Settings";
import { useSettings } from "./hooks/useSettings";
import { confirmQuit, readPrompt, saveAttachment } from "./services/tauri";
import { buildPromptSlashItems } from "./utils/slash";
import { expandPromptTemplate, parsePromptInvocation } from "./utils/prompts";
import type { AccessMode, ComposerAttachment } from "./types";

type MainAppProps = {
  accessMode: AccessMode;
  onAccessModeChange: (mode: AccessMode) => void;
};

function MainApp({ accessMode, onAccessModeChange }: MainAppProps) {
  const [centerMode, setCenterMode] = useState<"chat" | "diff">("chat");
  const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null);
  const [isConfirmQuitOpen, setIsConfirmQuitOpen] = useState(false);
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
  } = useWorkspaces({ onDebug: addDebugEntry });

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

  const resolvedModel = selectedModel?.model ?? null;
  const fileStatus =
    gitStatus.files.length > 0
      ? `${gitStatus.files.length} file${gitStatus.files.length === 1 ? "" : "s"} changed`
      : "Working tree clean";

  const {
    setActiveThreadId,
    activeThreadId,
    activeItems,
    approvals,
    threadsByWorkspace,
    threadStatusById,
    removeThread,
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
  });

  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [pendingAttachmentCount, setPendingAttachmentCount] = useState(0);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const activeWorkspaceIdRef = useRef<string | null>(null);
  const activeThreadIdRef = useRef<string | null>(null);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    activeWorkspaceIdRef.current = activeWorkspaceId ?? null;
    activeThreadIdRef.current = activeThreadId ?? null;
  }, [activeWorkspaceId, activeThreadId]);

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

  return (
    <div className="app">
      <Sidebar
        workspaces={workspaces}
        threadsByWorkspace={threadsByWorkspace}
        threadStatusById={threadStatusById}
        activeWorkspaceId={activeWorkspaceId}
        activeThreadId={activeThreadId}
        onAddWorkspace={handleAddWorkspace}
        onSelectWorkspace={(workspaceId) => {
          exitDiffView();
          setActiveWorkspaceId(workspaceId);
        }}
        onConnectWorkspace={connectWorkspace}
        onAddAgent={handleAddAgent}
        onSelectThread={(workspaceId, threadId) => {
          exitDiffView();
          setActiveWorkspaceId(workspaceId);
          setActiveThreadId(threadId, workspaceId);
        }}
        onDeleteThread={(workspaceId, threadId) => {
          removeThread(workspaceId, threadId);
        }}
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
              />
            )}
            <DebugPanel
              entries={debugEntries}
              isOpen={debugOpen}
              onToggle={() => setDebugOpen((prev) => !prev)}
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
  const { settings, updateSettings } = useSettings();

  useEffect(() => {
    const handleHashChange = () => setRoute(window.location.hash);
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  if (route.startsWith("#/settings")) {
    return (
      <Settings
        settings={settings}
        onUpdateSettings={updateSettings}
      />
    );
  }

  return (
    <MainApp
      accessMode={settings.accessMode}
      onAccessModeChange={(mode) => updateSettings({ accessMode: mode })}
    />
  );
}
