export type WorkspaceInfo = {
  id: string;
  name: string;
  path: string;
  connected: boolean;
  codex_bin?: string | null;
};

export type AppServerEvent = {
  workspace_id: string;
  message: Record<string, unknown>;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type ConversationItem =
  | {
      id: string;
      kind: "message";
      role: "user" | "assistant";
      text: string;
      attachments?: LocalImageInput[];
    }
  | { id: string; kind: "reasoning"; summary: string; content: string }
  | { id: string; kind: "diff"; title: string; diff: string; status?: string }
  | { id: string; kind: "review"; state: "started" | "completed"; text: string }
  | {
      id: string;
      kind: "tool";
      toolType: string;
      title: string;
      detail: string;
      status?: string;
      output?: string;
      changes?: { path: string; kind?: string; diff?: string }[];
    };

export type SessionNameSource = "default" | "custom";

export type SessionMetadata = {
  name: string;
  archived: boolean;
  nameSource: SessionNameSource;
};

export type WorkspaceSessionStore = {
  version: number;
  sessions: Record<string, SessionMetadata>;
};

export type ThreadSummary = {
  id: string;
  name: string;
  archived: boolean;
};

export type ReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title?: string }
  | { type: "custom"; instructions: string };

export type AccessMode = "read-only" | "current" | "full-access";

export type ComposerAttachment = {
  id: string;
  name: string;
  size: number;
  mime: string;
  path: string;
  previewUrl: string;
};

export type LocalImageInput = {
  path: string;
};

export type ThemePreference = "system" | "light" | "dark";

export type UsageSource = "app-server" | "sessions" | "none";

export type UsageSnapshot = {
  totalTokens24h: number | null;
  updatedAtMs: number | null;
  source: UsageSource;
  rateLimits: RateLimitSnapshot | null;
};

export type RateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type RateLimitSnapshot = {
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
};

export type AppSettings = {
  themePreference: ThemePreference;
  accessMode: AccessMode;
  bypassApprovalsAndSandbox: boolean;
  enableWebSearchRequest: boolean;
  confirmBeforeQuit: boolean;
  enableCompletionNotifications: boolean;
  usagePollingEnabled: boolean;
  usagePollingIntervalMinutes: number;
  sidebarWidth: number;
  glassBlurLight: number;
  glassBlurDark: number;
  glassOpacityLight: number;
  glassOpacityDark: number;
  codexBinPath: string | null;
  nodeBinPath: string | null;
  workspaceSidebarExpanded: Record<string, boolean>;
};

export type CodexBinInspection = {
  requiresNode: boolean;
  suggestedNodePath: string | null;
  resolvedPath: string;
};

export type ApprovalRequest = {
  workspace_id: string;
  request_id: number;
  method: string;
  params: Record<string, unknown>;
};

export type GitFileStatus = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
};

export type GitFileDiff = {
  path: string;
  diff: string;
};

export type ModelOption = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string;
  isDefault: boolean;
};

export type SkillOption = {
  name: string;
  path: string;
  description?: string;
};

export type PromptOption = {
  name: string;
  path: string;
  description?: string;
  argumentHint?: string;
};

export type PromptFile = {
  name: string;
  body: string;
  description?: string;
  argumentHint?: string;
};

export type SlashItem = {
  id: string;
  kind: "prompt" | "file";
  title: string;
  description?: string;
  hint?: string;
  insertText: string;
};

export type DebugEntry = {
  id: string;
  timestamp: number;
  source: "client" | "server" | "event" | "stderr" | "error";
  label: string;
  payload?: unknown;
};
