import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import type {
  ApprovalRequest,
  AppServerEvent,
  ConversationItem,
  DebugEntry,
  LocalImageInput,
  SessionMetadata,
  SessionNameSource,
  ThreadSummary,
  WorkspaceSessionStore,
  WorkspaceInfo,
} from "../types";
import {
  respondToServerRequest,
  sendUserMessage as sendUserMessageService,
  cancelTurn as cancelTurnService,
  startReview as startReviewService,
  startThread as startThreadService,
  listThreads as listThreadsService,
  resumeThread as resumeThreadService,
  getWorkspaceSessions,
  saveWorkspaceSessions,
} from "../services/tauri";
import { useAppServerEvents } from "./useAppServerEvents";

const emptyItems: Record<string, ConversationItem[]> = {};
const DEFAULT_SESSION_STORE_VERSION = 1;
type MessageItem = Extract<ConversationItem, { kind: "message" }>;
type ToolItem = Extract<ConversationItem, { kind: "tool" }>;

function createSessionStore(): WorkspaceSessionStore {
  return { version: DEFAULT_SESSION_STORE_VERSION, sessions: {} };
}

function normalizeNameSource(value: SessionNameSource | string | undefined): SessionNameSource {
  return value === "custom" ? "custom" : "default";
}

function normalizeSessionStore(
  store: WorkspaceSessionStore | null | undefined,
): WorkspaceSessionStore {
  if (!store) {
    return createSessionStore();
  }
  const sessions: Record<string, SessionMetadata> = {};
  const rawSessions = store.sessions ?? {};
  Object.entries(rawSessions).forEach(([id, entry]) => {
    if (!entry) {
      return;
    }
    const name = typeof entry.name === "string" ? entry.name : "";
    sessions[id] = {
      name,
      archived: Boolean(entry.archived),
      nameSource: normalizeNameSource(entry.nameSource),
    };
  });
  return {
    version:
      typeof store.version === "number"
        ? store.version
        : DEFAULT_SESSION_STORE_VERSION,
    sessions,
  };
}

type ThreadState = {
  activeThreadIdByWorkspace: Record<string, string | null>;
  itemsByThread: Record<string, ConversationItem[]>;
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
  approvals: ApprovalRequest[];
};

type ThreadAction =
  | { type: "setActiveThreadId"; workspaceId: string; threadId: string | null }
  | { type: "ensureThread"; workspaceId: string; threadId: string }
  | {
      type: "setThreadArchived";
      workspaceId: string;
      threadId: string;
      archived: boolean;
    }
  | { type: "markProcessing"; threadId: string; isProcessing: boolean }
  | { type: "markReviewing"; threadId: string; isReviewing: boolean }
  | { type: "markUnread"; threadId: string; hasUnread: boolean }
  | { type: "markCanceling"; threadId: string; isCanceling: boolean }
  | {
      type: "addUserMessage";
      threadId: string;
      text: string;
      attachments?: LocalImageInput[];
    }
  | { type: "setThreadName"; workspaceId: string; threadId: string; name: string }
  | { type: "appendAgentDelta"; threadId: string; itemId: string; delta: string }
  | { type: "completeAgentMessage"; threadId: string; itemId: string; text: string }
  | { type: "upsertItem"; threadId: string; item: ConversationItem }
  | { type: "setThreadItems"; threadId: string; items: ConversationItem[] }
  | {
      type: "appendReasoningSummary";
      threadId: string;
      itemId: string;
      delta: string;
    }
  | { type: "appendReasoningContent"; threadId: string; itemId: string; delta: string }
  | { type: "appendToolOutput"; threadId: string; itemId: string; delta: string }
  | { type: "setThreads"; workspaceId: string; threads: ThreadSummary[] }
  | { type: "removeWorkspace"; workspaceId: string }
  | { type: "addApproval"; approval: ApprovalRequest }
  | { type: "removeApproval"; requestId: number };

const initialState: ThreadState = {
  activeThreadIdByWorkspace: {},
  itemsByThread: emptyItems,
  threadsByWorkspace: {},
  threadStatusById: {},
  approvals: [],
};

function upsertItem(list: ConversationItem[], item: ConversationItem) {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index === -1) {
    return [...list, item];
  }
  const next = [...list];
  next[index] = { ...next[index], ...item };
  return next;
}

function threadReducer(state: ThreadState, action: ThreadAction): ThreadState {
  switch (action.type) {
    case "setActiveThreadId":
      return {
        ...state,
        activeThreadIdByWorkspace: {
          ...state.activeThreadIdByWorkspace,
          [action.workspaceId]: action.threadId,
        },
        threadStatusById: action.threadId
          ? {
              ...state.threadStatusById,
              [action.threadId]: {
                isProcessing:
                  state.threadStatusById[action.threadId]?.isProcessing ?? false,
                hasUnread: false,
                isReviewing:
                  state.threadStatusById[action.threadId]?.isReviewing ?? false,
                isCanceling:
                  state.threadStatusById[action.threadId]?.isCanceling ?? false,
              },
            }
          : state.threadStatusById,
      };
    case "ensureThread": {
      const list = state.threadsByWorkspace[action.workspaceId] ?? [];
      if (list.some((thread) => thread.id === action.threadId)) {
        return state;
      }
      const thread: ThreadSummary = {
        id: action.threadId,
        name: `Agent ${list.length + 1}`,
        archived: false,
      };
      return {
        ...state,
        threadsByWorkspace: {
          ...state.threadsByWorkspace,
          [action.workspaceId]: [thread, ...list],
        },
        threadStatusById: {
          ...state.threadStatusById,
          [action.threadId]: {
            isProcessing: false,
            hasUnread: false,
            isReviewing: false,
            isCanceling: false,
          },
        },
        activeThreadIdByWorkspace: {
          ...state.activeThreadIdByWorkspace,
          [action.workspaceId]:
            state.activeThreadIdByWorkspace[action.workspaceId] ?? action.threadId,
        },
      };
    }
    case "setThreadArchived": {
      const list = state.threadsByWorkspace[action.workspaceId] ?? [];
      const next = list.map((thread) =>
        thread.id === action.threadId
          ? { ...thread, archived: action.archived }
          : thread,
      );
      return {
        ...state,
        threadsByWorkspace: {
          ...state.threadsByWorkspace,
          [action.workspaceId]: next,
        },
      };
    }
    case "markProcessing":
      return {
        ...state,
        threadStatusById: {
          ...state.threadStatusById,
          [action.threadId]: {
            isProcessing: action.isProcessing,
            hasUnread: state.threadStatusById[action.threadId]?.hasUnread ?? false,
            isReviewing:
              state.threadStatusById[action.threadId]?.isReviewing ?? false,
            isCanceling:
              state.threadStatusById[action.threadId]?.isCanceling ?? false,
          },
        },
      };
    case "markReviewing":
      return {
        ...state,
        threadStatusById: {
          ...state.threadStatusById,
          [action.threadId]: {
            isProcessing:
              state.threadStatusById[action.threadId]?.isProcessing ?? false,
            hasUnread: state.threadStatusById[action.threadId]?.hasUnread ?? false,
            isReviewing: action.isReviewing,
            isCanceling:
              state.threadStatusById[action.threadId]?.isCanceling ?? false,
          },
        },
      };
    case "markUnread":
      return {
        ...state,
        threadStatusById: {
          ...state.threadStatusById,
          [action.threadId]: {
            isProcessing:
              state.threadStatusById[action.threadId]?.isProcessing ?? false,
            hasUnread: action.hasUnread,
            isReviewing:
              state.threadStatusById[action.threadId]?.isReviewing ?? false,
            isCanceling:
              state.threadStatusById[action.threadId]?.isCanceling ?? false,
          },
        },
      };
    case "markCanceling":
      return {
        ...state,
        threadStatusById: {
          ...state.threadStatusById,
          [action.threadId]: {
            isProcessing:
              state.threadStatusById[action.threadId]?.isProcessing ?? false,
            hasUnread: state.threadStatusById[action.threadId]?.hasUnread ?? false,
            isReviewing:
              state.threadStatusById[action.threadId]?.isReviewing ?? false,
            isCanceling: action.isCanceling,
          },
        },
      };
    case "addUserMessage": {
      const list = state.itemsByThread[action.threadId] ?? [];
      const message: ConversationItem = {
        id: `${Date.now()}-user`,
        kind: "message",
        role: "user",
        text: action.text,
        attachments:
          action.attachments && action.attachments.length > 0
            ? action.attachments
            : undefined,
      };
      return {
        ...state,
        itemsByThread: {
          ...state.itemsByThread,
          [action.threadId]: [...list, message],
        },
      };
    }
    case "setThreadName": {
      const list = state.threadsByWorkspace[action.workspaceId] ?? [];
      const next = list.map((thread) =>
        thread.id === action.threadId ? { ...thread, name: action.name } : thread,
      );
      return {
        ...state,
        threadsByWorkspace: {
          ...state.threadsByWorkspace,
          [action.workspaceId]: next,
        },
      };
    }
    case "appendAgentDelta": {
      const list = [...(state.itemsByThread[action.threadId] ?? [])];
      const index = list.findIndex((msg) => msg.id === action.itemId);
      const existing = index >= 0 ? list[index] : null;
      if (existing && existing.kind === "message") {
        const message = existing as MessageItem;
        list[index] = {
          ...message,
          text: `${message.text}${action.delta}`,
        };
      } else {
        list.push({
          id: action.itemId,
          kind: "message",
          role: "assistant",
          text: action.delta,
        });
      }
      return {
        ...state,
        itemsByThread: { ...state.itemsByThread, [action.threadId]: list },
      };
    }
    case "completeAgentMessage": {
      const list = [...(state.itemsByThread[action.threadId] ?? [])];
      const index = list.findIndex((msg) => msg.id === action.itemId);
      const existing = index >= 0 ? list[index] : null;
      if (existing && existing.kind === "message") {
        const message = existing as MessageItem;
        list[index] = {
          ...message,
          text: action.text || message.text,
        };
      } else {
        list.push({
          id: action.itemId,
          kind: "message",
          role: "assistant",
          text: action.text,
        });
      }
      return {
        ...state,
        itemsByThread: { ...state.itemsByThread, [action.threadId]: list },
      };
    }
    case "upsertItem": {
      const list = state.itemsByThread[action.threadId] ?? [];
      return {
        ...state,
        itemsByThread: {
          ...state.itemsByThread,
          [action.threadId]: upsertItem(list, action.item),
        },
      };
    }
    case "setThreadItems":
      return {
        ...state,
        itemsByThread: {
          ...state.itemsByThread,
          [action.threadId]: action.items,
        },
      };
    case "appendReasoningSummary": {
      const list = state.itemsByThread[action.threadId] ?? [];
      const index = list.findIndex((entry) => entry.id === action.itemId);
      const base =
        index >= 0 && list[index].kind === "reasoning"
          ? (list[index] as ConversationItem)
          : {
              id: action.itemId,
              kind: "reasoning",
              summary: "",
              content: "",
            };
      const updated: ConversationItem = {
        ...base,
        summary: `${"summary" in base ? base.summary : ""}${action.delta}`,
      } as ConversationItem;
      const next = index >= 0 ? [...list] : [...list, updated];
      if (index >= 0) {
        next[index] = updated;
      }
      return {
        ...state,
        itemsByThread: { ...state.itemsByThread, [action.threadId]: next },
      };
    }
    case "appendReasoningContent": {
      const list = state.itemsByThread[action.threadId] ?? [];
      const index = list.findIndex((entry) => entry.id === action.itemId);
      const base =
        index >= 0 && list[index].kind === "reasoning"
          ? (list[index] as ConversationItem)
          : {
              id: action.itemId,
              kind: "reasoning",
              summary: "",
              content: "",
            };
      const updated: ConversationItem = {
        ...base,
        content: `${"content" in base ? base.content : ""}${action.delta}`,
      } as ConversationItem;
      const next = index >= 0 ? [...list] : [...list, updated];
      if (index >= 0) {
        next[index] = updated;
      }
      return {
        ...state,
        itemsByThread: { ...state.itemsByThread, [action.threadId]: next },
      };
    }
    case "appendToolOutput": {
      const list = state.itemsByThread[action.threadId] ?? [];
      const index = list.findIndex((entry) => entry.id === action.itemId);
      if (index < 0) {
        return state;
      }
      const existing = list[index];
      if (existing.kind !== "tool") {
        return state;
      }
      const toolItem = existing as ToolItem;
      const updated: ToolItem = {
        ...toolItem,
        output: `${toolItem.output ?? ""}${action.delta}`,
      };
      const next = [...list];
      next[index] = updated;
      return {
        ...state,
        itemsByThread: { ...state.itemsByThread, [action.threadId]: next },
      };
    }
    case "addApproval":
      return { ...state, approvals: [...state.approvals, action.approval] };
    case "removeApproval":
      return {
        ...state,
        approvals: state.approvals.filter(
          (item) => item.request_id !== action.requestId,
        ),
      };
    case "setThreads": {
      return {
        ...state,
        threadsByWorkspace: {
          ...state.threadsByWorkspace,
          [action.workspaceId]: action.threads,
        },
      };
    }
    case "removeWorkspace": {
      const threads = state.threadsByWorkspace[action.workspaceId] ?? [];
      const nextThreadsByWorkspace = { ...state.threadsByWorkspace };
      delete nextThreadsByWorkspace[action.workspaceId];
      const nextActiveThreadIdByWorkspace = {
        ...state.activeThreadIdByWorkspace,
      };
      delete nextActiveThreadIdByWorkspace[action.workspaceId];
      const nextItemsByThread = { ...state.itemsByThread };
      const nextThreadStatusById = { ...state.threadStatusById };
      for (const thread of threads) {
        delete nextItemsByThread[thread.id];
        delete nextThreadStatusById[thread.id];
      }
      const nextApprovals = state.approvals.filter(
        (item) => item.workspace_id !== action.workspaceId,
      );
      return {
        ...state,
        threadsByWorkspace: nextThreadsByWorkspace,
        activeThreadIdByWorkspace: nextActiveThreadIdByWorkspace,
        itemsByThread: nextItemsByThread,
        threadStatusById: nextThreadStatusById,
        approvals: nextApprovals,
      };
    }
    default:
      return state;
  }
}

type UseThreadsOptions = {
  activeWorkspace: WorkspaceInfo | null;
  onWorkspaceConnected: (id: string) => void;
  onDebug?: (entry: DebugEntry) => void;
  model?: string | null;
  effort?: string | null;
  accessMode?: "read-only" | "current" | "full-access";
  onMessageActivity?: () => void;
  notifications?: {
    enabled: boolean;
    workspaces: WorkspaceInfo[];
    onOpenThread: (workspaceId: string, threadId: string) => void;
  };
};

function asString(value: unknown) {
  return typeof value === "string" ? value : value ? String(value) : "";
}

function parseReviewTarget(input: string) {
  const trimmed = input.trim();
  const rest = trimmed.replace(/^\/review\b/i, "").trim();
  if (!rest) {
    return { type: "uncommittedChanges" } as const;
  }
  const lower = rest.toLowerCase();
  if (lower.startsWith("base ")) {
    const branch = rest.slice(5).trim();
    return { type: "baseBranch", branch } as const;
  }
  if (lower.startsWith("commit ")) {
    const payload = rest.slice(7).trim();
    const [sha, ...titleParts] = payload.split(/\s+/);
    const title = titleParts.join(" ").trim();
    return {
      type: "commit",
      sha,
      ...(title ? { title } : {}),
    } as const;
  }
  if (lower.startsWith("custom ")) {
    const instructions = rest.slice(7).trim();
    return { type: "custom", instructions } as const;
  }
  return { type: "custom", instructions: rest } as const;
}

function formatReviewLabel(target: ReturnType<typeof parseReviewTarget>) {
  if (target.type === "uncommittedChanges") {
    return "current changes";
  }
  if (target.type === "baseBranch") {
    return `base branch ${target.branch}`;
  }
  if (target.type === "commit") {
    return target.title
      ? `commit ${target.sha}: ${target.title}`
      : `commit ${target.sha}`;
  }
  const instructions = target.instructions.trim();
  if (!instructions) {
    return "custom review";
  }
  return instructions.length > 80
    ? `${instructions.slice(0, 80)}…`
    : instructions;
}

function buildConversationItem(item: Record<string, unknown>): ConversationItem | null {
  const type = asString(item.type);
  const id = asString(item.id);
  if (!id || !type) {
    return null;
  }
  if (type === "agentMessage" || type === "userMessage") {
    return null;
  }
  if (type === "reasoning") {
    const summary = asString(item.summary ?? "");
    const content = Array.isArray(item.content)
      ? item.content.map((entry) => asString(entry)).join("\n")
      : asString(item.content ?? "");
    return { id, kind: "reasoning", summary, content };
  }
  if (type === "commandExecution") {
    const command = Array.isArray(item.command)
      ? item.command.map((part) => asString(part)).join(" ")
      : asString(item.command ?? "");
    return {
      id,
      kind: "tool",
      toolType: type,
      title: command ? `Command: ${command}` : "Command",
      detail: asString(item.cwd ?? ""),
      status: asString(item.status ?? ""),
      output: asString(item.aggregatedOutput ?? ""),
    };
  }
  if (type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const normalizedChanges = changes
      .map((change) => {
        const path = asString(change?.path ?? "");
        const kind = change?.kind as Record<string, unknown> | string | undefined;
        const kindType =
          typeof kind === "string"
            ? kind
            : typeof kind === "object" && kind
              ? asString((kind as Record<string, unknown>).type ?? "")
              : "";
        const normalizedKind = kindType ? kindType.toLowerCase() : "";
        const diff = asString(change?.diff ?? "");
        return { path, kind: normalizedKind || undefined, diff: diff || undefined };
      })
      .filter((change) => change.path);
    const formattedChanges = normalizedChanges
      .map((change) => {
        const prefix =
          change.kind === "add"
            ? "A"
            : change.kind === "delete"
              ? "D"
              : change.kind
                ? "M"
                : "";
        return [prefix, change.path].filter(Boolean).join(" ");
      })
      .filter(Boolean);
    const paths = formattedChanges.join(", ");
    const diffOutput = normalizedChanges
      .map((change) => change.diff ?? "")
      .filter(Boolean)
      .join("\n\n");
    return {
      id,
      kind: "tool",
      toolType: type,
      title: "File changes",
      detail: paths || "Pending changes",
      status: asString(item.status ?? ""),
      output: diffOutput,
      changes: normalizedChanges,
    };
  }
  if (type === "mcpToolCall") {
    const server = asString(item.server ?? "");
    const tool = asString(item.tool ?? "");
    const args = item.arguments ? JSON.stringify(item.arguments, null, 2) : "";
    return {
      id,
      kind: "tool",
      toolType: type,
      title: `Tool: ${server}${tool ? ` / ${tool}` : ""}`,
      detail: args,
      status: asString(item.status ?? ""),
      output: asString(item.result ?? item.error ?? ""),
    };
  }
  if (type === "webSearch") {
    return {
      id,
      kind: "tool",
      toolType: type,
      title: "Web search",
      detail: asString(item.query ?? ""),
      status: "",
      output: "",
    };
  }
  if (type === "imageView") {
    return {
      id,
      kind: "tool",
      toolType: type,
      title: "Image view",
      detail: asString(item.path ?? ""),
      status: "",
      output: "",
    };
  }
  if (type === "enteredReviewMode" || type === "exitedReviewMode") {
    return {
      id,
      kind: "review",
      state: type === "enteredReviewMode" ? "started" : "completed",
      text: asString(item.review ?? ""),
    };
  }
  return null;
}

function userInputsToText(inputs: Array<Record<string, unknown>>) {
  return inputs
    .map((input) => {
      const type = asString(input.type);
      if (type === "text") {
        return asString(input.text);
      }
      if (type === "skill") {
        const name = asString(input.name);
        return name ? `$${name}` : "";
      }
      if (type === "image" || type === "localImage") {
        return "[image]";
      }
      return "";
    })
    .filter(Boolean)
    .join(" ")
    .trim();
}

function userInputsToAttachments(
  inputs: Array<Record<string, unknown>>,
): LocalImageInput[] {
  const attachments: LocalImageInput[] = [];
  inputs.forEach((input) => {
    const type = asString(input.type);
    if (type === "localImage") {
      const path = asString((input as Record<string, unknown>).path);
      if (path) {
        attachments.push({ path });
      }
    }
  });
  return attachments;
}

function buildConversationItemFromThreadItem(
  item: Record<string, unknown>,
): ConversationItem | null {
  const type = asString(item.type);
  const id = asString(item.id);
  if (!id || !type) {
    return null;
  }
  if (type === "userMessage") {
    const content = Array.isArray(item.content) ? item.content : [];
    const text = userInputsToText(content);
    const attachments = userInputsToAttachments(content);
    const tokens = text.split(/\s+/).filter(Boolean);
    const onlyImageTokens =
      tokens.length > 0 && tokens.every((token) => token === "[image]");
    const displayText = attachments.length > 0 && onlyImageTokens ? "" : text;
    return {
      id,
      kind: "message",
      role: "user",
      text: displayText || (attachments.length > 0 ? "" : "[message]"),
      attachments: attachments.length > 0 ? attachments : undefined,
    };
  }
  if (type === "agentMessage") {
    return {
      id,
      kind: "message",
      role: "assistant",
      text: asString(item.text),
    };
  }
  if (type === "reasoning") {
    const summary = Array.isArray(item.summary)
      ? item.summary.map((entry) => asString(entry)).join("\n")
      : asString(item.summary ?? "");
    const content = Array.isArray(item.content)
      ? item.content.map((entry) => asString(entry)).join("\n")
      : asString(item.content ?? "");
    return { id, kind: "reasoning", summary, content };
  }
  return buildConversationItem(item);
}

function buildItemsFromThread(thread: Record<string, unknown>) {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const items: ConversationItem[] = [];
  turns.forEach((turn) => {
    const turnItems = Array.isArray((turn as Record<string, unknown>)?.items)
      ? ((turn as Record<string, unknown>).items as Record<string, unknown>[])
      : [];
    turnItems.forEach((item: Record<string, unknown>) => {
      const converted = buildConversationItemFromThreadItem(item);
      if (converted) {
        items.push(converted);
      }
    });
  });
  return items;
}

function isReviewingFromThread(thread: Record<string, unknown>) {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  let reviewing = false;
  turns.forEach((turn) => {
    const turnItems = Array.isArray((turn as Record<string, unknown>)?.items)
      ? ((turn as Record<string, unknown>).items as Record<string, unknown>[])
      : [];
    turnItems.forEach((item: Record<string, unknown>) => {
      const type = asString((item as Record<string, unknown>)?.type ?? "");
      if (type === "enteredReviewMode") {
        reviewing = true;
      } else if (type === "exitedReviewMode") {
        reviewing = false;
      }
    });
  });
  return reviewing;
}

function previewThreadName(text: string, fallback: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.length > 38 ? `${trimmed.slice(0, 38)}…` : trimmed;
}

function formatNotificationBody(text: string, limit = 160) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "Agent finished a reply.";
  }
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact;
}

export function useThreads({
  activeWorkspace,
  onWorkspaceConnected,
  onDebug,
  model,
  effort,
  accessMode,
  onMessageActivity,
  notifications,
}: UseThreadsOptions) {
  const [state, dispatch] = useReducer(threadReducer, initialState);
  const loadedThreads = useRef<Record<string, boolean>>({});
  const threadsByWorkspaceRef = useRef<Record<string, ThreadSummary[]>>({});
  const sessionStoreByWorkspaceRef =
    useRef<Record<string, WorkspaceSessionStore>>({});

  useEffect(() => {
    threadsByWorkspaceRef.current = state.threadsByWorkspace;
  }, [state.threadsByWorkspace]);

  const activeWorkspaceId = activeWorkspace?.id ?? null;
  const activeThreadId = useMemo(() => {
    if (!activeWorkspaceId) {
      return null;
    }
    return state.activeThreadIdByWorkspace[activeWorkspaceId] ?? null;
  }, [activeWorkspaceId, state.activeThreadIdByWorkspace]);

  const activeItems = useMemo(
    () => (activeThreadId ? state.itemsByThread[activeThreadId] ?? [] : []),
    [activeThreadId, state.itemsByThread],
  );

  const notificationPermissionRef = useRef<"unknown" | "granted" | "denied">(
    "unknown",
  );

  const ensureNotificationPermission = useCallback(async () => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      return false;
    }
    const cached = notificationPermissionRef.current;
    if (cached === "granted") {
      return true;
    }
    if (cached === "denied") {
      return false;
    }
    try {
      const granted = await isPermissionGranted();
      if (granted) {
        notificationPermissionRef.current = "granted";
        return true;
      }
      const permission = await requestPermission();
      const allowed = permission === "granted";
      notificationPermissionRef.current = allowed ? "granted" : "denied";
      return allowed;
    } catch {
      return false;
    }
  }, []);

  const notifyAgentCompletion = useCallback(
    async (workspaceId: string, threadId: string, text: string) => {
      const notificationConfig = notifications;
      if (!notificationConfig?.enabled) {
        return;
      }
      if (typeof document !== "undefined") {
        const isActiveThread =
          workspaceId === activeWorkspaceId && threadId === activeThreadId;
        const isForeground =
          document.visibilityState === "visible" && document.hasFocus();
        if (isActiveThread && isForeground) {
          return;
        }
      }
      const allowed = await ensureNotificationPermission();
      if (!allowed) {
        return;
      }
      const workspaceName =
        notificationConfig.workspaces.find(
          (workspace) => workspace.id === workspaceId,
        )?.name ?? "Workspace";
      const threadName =
        threadsByWorkspaceRef.current[workspaceId]?.find(
          (thread) => thread.id === threadId,
        )?.name ?? "Agent";
      const title = `${workspaceName} · ${threadName}`;
      const body = formatNotificationBody(text);
      try {
        const notification = new window.Notification(title, {
          body,
          tag: `${workspaceId}:${threadId}`,
        });
        notification.onclick = () => {
          try {
            notification.close?.();
          } catch {
            // Ignore close errors.
          }
          try {
            const windowHandle = getCurrentWindow();
            void windowHandle.show();
            void windowHandle.setFocus();
          } catch {
            // Ignore focus errors.
          }
          try {
            notificationConfig.onOpenThread(workspaceId, threadId);
          } catch {
            // Ignore open errors.
          }
        };
      } catch {
        // Ignore notification errors.
      }
    },
    [
      activeThreadId,
      activeWorkspaceId,
      ensureNotificationPermission,
      notifications,
    ],
  );

  const logSessionError = useCallback(
    (label: string, error: unknown) => {
      onDebug?.({
        id: `${Date.now()}-client-session-${label}-error`,
        timestamp: Date.now(),
        source: "error",
        label: `session/${label} error`,
        payload: error instanceof Error ? error.message : String(error),
      });
    },
    [onDebug],
  );

  const getSessionStore = useCallback(
    async (workspaceId: string) => {
      const cached = sessionStoreByWorkspaceRef.current[workspaceId];
      if (cached) {
        return cached;
      }
      try {
        const store = normalizeSessionStore(
          await getWorkspaceSessions(workspaceId),
        );
        sessionStoreByWorkspaceRef.current[workspaceId] = store;
        return store;
      } catch (error) {
        logSessionError("read", error);
        const fallback = createSessionStore();
        sessionStoreByWorkspaceRef.current[workspaceId] = fallback;
        return fallback;
      }
    },
    [logSessionError],
  );

  const persistSessionStore = useCallback(
    async (workspaceId: string, store: WorkspaceSessionStore) => {
      try {
        await saveWorkspaceSessions(workspaceId, store);
      } catch (error) {
        logSessionError("write", error);
      }
    },
    [logSessionError],
  );

  const getFallbackThreadName = useCallback((workspaceId: string, threadId: string) => {
    const list = threadsByWorkspaceRef.current[workspaceId] ?? [];
    const existing = list.find((thread) => thread.id === threadId);
    if (existing?.name) {
      return existing.name;
    }
    return `Agent ${threadId.slice(0, 4)}`;
  }, []);

  const ensureSessionEntry = useCallback(
    async (workspaceId: string, threadId: string, fallbackName: string) => {
      const store = await getSessionStore(workspaceId);
      const existing = store.sessions[threadId];
      const nameSource = existing ? normalizeNameSource(existing.nameSource) : "default";
      const archived = existing?.archived ?? false;
      const name = existing?.name?.trim() ? existing.name : fallbackName;
      const shouldUpdate =
        !existing ||
        existing.name !== name ||
        existing.archived !== archived ||
        existing.nameSource !== nameSource;
      if (shouldUpdate) {
        store.sessions[threadId] = { name, archived, nameSource };
        sessionStoreByWorkspaceRef.current[workspaceId] = store;
        await persistSessionStore(workspaceId, store);
      }
    },
    [getSessionStore, persistSessionStore],
  );

  const setDefaultThreadName = useCallback(
    async (workspaceId: string, threadId: string, nextName: string) => {
      const trimmed = nextName.trim();
      if (!trimmed) {
        return;
      }
      const store = await getSessionStore(workspaceId);
      const existing = store.sessions[threadId];
      if (existing?.nameSource === "custom") {
        return;
      }
      const archived = existing?.archived ?? false;
      const entry: SessionMetadata = {
        name: trimmed,
        archived,
        nameSource: "default",
      };
      const shouldUpdate =
        !existing ||
        existing.name !== entry.name ||
        existing.archived !== entry.archived ||
        existing.nameSource !== entry.nameSource;
      if (shouldUpdate) {
        store.sessions[threadId] = entry;
        sessionStoreByWorkspaceRef.current[workspaceId] = store;
        await persistSessionStore(workspaceId, store);
      }
      const list = threadsByWorkspaceRef.current[workspaceId] ?? [];
      const current = list.find((thread) => thread.id === threadId);
      if (!current || current.name !== trimmed) {
        dispatch({ type: "setThreadName", workspaceId, threadId, name: trimmed });
      }
    },
    [getSessionStore, persistSessionStore],
  );

  const handleWorkspaceConnected = useCallback(
    (workspaceId: string) => {
      onWorkspaceConnected(workspaceId);
    },
    [onWorkspaceConnected],
  );

  const handlers = useMemo(
    () => ({
      onWorkspaceConnected: handleWorkspaceConnected,
      onApprovalRequest: (approval: ApprovalRequest) => {
        dispatch({ type: "addApproval", approval });
      },
      onAppServerEvent: (event: AppServerEvent) => {
        const method = String(event.message?.method ?? "");
        const inferredSource =
          method === "codex/stderr" ? "stderr" : "event";
        onDebug?.({
          id: `${Date.now()}-server-event`,
          timestamp: Date.now(),
          source: inferredSource,
          label: method || "event",
          payload: event,
        });
      },
      onAgentMessageDelta: ({
        workspaceId,
        threadId,
        itemId,
        delta,
      }: {
        workspaceId: string;
        threadId: string;
        itemId: string;
        delta: string;
      }) => {
        dispatch({ type: "ensureThread", workspaceId, threadId });
        dispatch({ type: "appendAgentDelta", threadId, itemId, delta });
      },
      onAgentMessageCompleted: ({
        workspaceId,
        threadId,
        itemId,
        text,
      }: {
        workspaceId: string;
        threadId: string;
        itemId: string;
        text: string;
      }) => {
        dispatch({ type: "ensureThread", workspaceId, threadId });
        dispatch({ type: "completeAgentMessage", threadId, itemId, text });
        dispatch({ type: "markProcessing", threadId, isProcessing: false });
        dispatch({ type: "markCanceling", threadId, isCanceling: false });
        try {
          void onMessageActivity?.();
        } catch {
          // Ignore refresh errors to avoid breaking the UI.
        }
        if (threadId !== activeThreadId) {
          dispatch({ type: "markUnread", threadId, hasUnread: true });
        }
        try {
          void notifyAgentCompletion(workspaceId, threadId, text);
        } catch {
          // Ignore notification errors.
        }
      },
      onItemStarted: (
        workspaceId: string,
        threadId: string,
        item: Record<string, unknown>,
      ) => {
        dispatch({ type: "ensureThread", workspaceId, threadId });
        const itemType = asString((item as Record<string, unknown>)?.type ?? "");
        if (itemType === "enteredReviewMode") {
          dispatch({ type: "markReviewing", threadId, isReviewing: true });
        } else if (itemType === "exitedReviewMode") {
          dispatch({ type: "markReviewing", threadId, isReviewing: false });
          dispatch({ type: "markProcessing", threadId, isProcessing: false });
          dispatch({ type: "markCanceling", threadId, isCanceling: false });
        }
        const converted = buildConversationItem(item);
        if (converted) {
          dispatch({ type: "upsertItem", threadId, item: converted });
        }
        try {
          void onMessageActivity?.();
        } catch {
          // Ignore refresh errors to avoid breaking the UI.
        }
      },
      onItemCompleted: (
        workspaceId: string,
        threadId: string,
        item: Record<string, unknown>,
      ) => {
        dispatch({ type: "ensureThread", workspaceId, threadId });
        const itemType = asString((item as Record<string, unknown>)?.type ?? "");
        if (itemType === "enteredReviewMode") {
          dispatch({ type: "markReviewing", threadId, isReviewing: true });
        } else if (itemType === "exitedReviewMode") {
          dispatch({ type: "markReviewing", threadId, isReviewing: false });
          dispatch({ type: "markProcessing", threadId, isProcessing: false });
          dispatch({ type: "markCanceling", threadId, isCanceling: false });
        }
        const converted = buildConversationItem(item);
        if (converted) {
          dispatch({ type: "upsertItem", threadId, item: converted });
        }
        try {
          void onMessageActivity?.();
        } catch {
          // Ignore refresh errors to avoid breaking the UI.
        }
      },
      onReasoningSummaryDelta: (
        _workspaceId: string,
        threadId: string,
        itemId: string,
        delta: string,
      ) => {
        dispatch({ type: "appendReasoningSummary", threadId, itemId, delta });
      },
      onReasoningTextDelta: (
        _workspaceId: string,
        threadId: string,
        itemId: string,
        delta: string,
      ) => {
        dispatch({ type: "appendReasoningContent", threadId, itemId, delta });
      },
      onCommandOutputDelta: (
        _workspaceId: string,
        threadId: string,
        itemId: string,
        delta: string,
      ) => {
        dispatch({ type: "appendToolOutput", threadId, itemId, delta });
        try {
          void onMessageActivity?.();
        } catch {
          // Ignore refresh errors to avoid breaking the UI.
        }
      },
      onFileChangeOutputDelta: (
        _workspaceId: string,
        threadId: string,
        itemId: string,
        delta: string,
      ) => {
        dispatch({ type: "appendToolOutput", threadId, itemId, delta });
        try {
          void onMessageActivity?.();
        } catch {
          // Ignore refresh errors to avoid breaking the UI.
        }
      },
      onTurnStarted: (workspaceId: string, threadId: string) => {
        dispatch({
          type: "ensureThread",
          workspaceId,
          threadId,
        });
        dispatch({ type: "markProcessing", threadId, isProcessing: true });
        dispatch({ type: "markCanceling", threadId, isCanceling: false });
      },
      onTurnCompleted: (_workspaceId: string, threadId: string) => {
        dispatch({ type: "markProcessing", threadId, isProcessing: false });
        dispatch({ type: "markReviewing", threadId, isReviewing: false });
        dispatch({ type: "markCanceling", threadId, isCanceling: false });
      },
      onTurnCanceled: (_workspaceId: string, threadId: string) => {
        dispatch({ type: "markProcessing", threadId, isProcessing: false });
        dispatch({ type: "markReviewing", threadId, isReviewing: false });
        dispatch({ type: "markCanceling", threadId, isCanceling: false });
      },
    }),
    [
      activeThreadId,
      activeWorkspaceId,
      handleWorkspaceConnected,
      notifyAgentCompletion,
      onDebug,
      onMessageActivity,
    ],
  );

  useAppServerEvents(handlers);

  const startThreadForWorkspace = useCallback(
    async (workspaceId: string) => {
      onDebug?.({
        id: `${Date.now()}-client-thread-start`,
        timestamp: Date.now(),
        source: "client",
        label: "thread/start",
        payload: { workspaceId },
      });
      try {
        const response = await startThreadService(workspaceId);
        onDebug?.({
          id: `${Date.now()}-server-thread-start`,
          timestamp: Date.now(),
          source: "server",
          label: "thread/start response",
          payload: response,
        });
        const thread = response.result?.thread ?? response.thread;
        const threadId = String(thread?.id ?? "");
        if (threadId) {
          dispatch({ type: "ensureThread", workspaceId, threadId });
          dispatch({ type: "setActiveThreadId", workspaceId, threadId });
          loadedThreads.current[threadId] = true;
          const list = threadsByWorkspaceRef.current[workspaceId] ?? [];
          const fallbackName = `Agent ${list.length + 1}`;
          void ensureSessionEntry(workspaceId, threadId, fallbackName);
          return threadId;
        }
        return null;
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-thread-start-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/start error",
          payload: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    [ensureSessionEntry, onDebug],
  );

  const startThread = useCallback(async () => {
    if (!activeWorkspaceId) {
      return null;
    }
    return startThreadForWorkspace(activeWorkspaceId);
  }, [activeWorkspaceId, startThreadForWorkspace]);

  const resumeThreadForWorkspace = useCallback(
    async (workspaceId: string, threadId: string, force = false) => {
      if (!threadId) {
        return null;
      }
      if (!force && loadedThreads.current[threadId]) {
        return threadId;
      }
      onDebug?.({
        id: `${Date.now()}-client-thread-resume`,
        timestamp: Date.now(),
        source: "client",
        label: "thread/resume",
        payload: { workspaceId, threadId },
      });
      try {
        const response = await resumeThreadService(workspaceId, threadId);
        onDebug?.({
          id: `${Date.now()}-server-thread-resume`,
          timestamp: Date.now(),
          source: "server",
          label: "thread/resume response",
          payload: response,
        });
        const thread = response.result?.thread ?? response.thread;
        if (thread) {
          const items = buildItemsFromThread(thread);
          if (items.length > 0) {
            dispatch({ type: "setThreadItems", threadId, items });
          }
          dispatch({
            type: "markReviewing",
            threadId,
            isReviewing: isReviewingFromThread(thread),
          });
          const preview = asString(thread?.preview ?? "").trim();
          if (preview) {
            const fallbackName = getFallbackThreadName(workspaceId, threadId);
            const nextName = previewThreadName(preview, fallbackName);
            void setDefaultThreadName(workspaceId, threadId, nextName);
          }
        }
        loadedThreads.current[threadId] = true;
        return threadId;
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-thread-resume-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/resume error",
          payload: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
    [getFallbackThreadName, onDebug, setDefaultThreadName],
  );

  const listThreadsForWorkspace = useCallback(
    async (workspace: WorkspaceInfo) => {
      onDebug?.({
        id: `${Date.now()}-client-thread-list`,
        timestamp: Date.now(),
        source: "client",
        label: "thread/list",
        payload: { workspaceId: workspace.id, path: workspace.path },
      });
      try {
        const allThreads: any[] = [];
        let cursor: string | null = null;
        do {
          const response = await listThreadsService(workspace.id, cursor, 50);
          onDebug?.({
            id: `${Date.now()}-server-thread-list`,
            timestamp: Date.now(),
            source: "server",
            label: "thread/list response",
            payload: response,
          });
          const result = response.result ?? response;
          const data = Array.isArray(result?.data) ? result.data : [];
          const nextCursor = result?.nextCursor ?? result?.next_cursor ?? null;
          allThreads.push(...data);
          cursor = nextCursor;
        } while (cursor);

        const matching = allThreads.filter(
          (thread) => String(thread?.cwd ?? "") === workspace.path,
        );
        matching.sort((a, b) => {
          const aCreated = Number(a?.createdAt ?? a?.created_at ?? 0);
          const bCreated = Number(b?.createdAt ?? b?.created_at ?? 0);
          return bCreated - aCreated;
        });
        const store = await getSessionStore(workspace.id);
        let hasSessionUpdates = false;
        const summaries = matching
          .map((thread, index) => {
            const threadId = String(thread?.id ?? "");
            if (!threadId) {
              return null;
            }
            const preview = asString(thread?.preview ?? "").trim();
            const fallbackName = `Agent ${index + 1}`;
            const existing = store.sessions[threadId];
            const nameSource = existing
              ? normalizeNameSource(existing.nameSource)
              : "default";
            const archived = existing?.archived ?? false;
            const hasPreview = preview.length > 0;

            let name = existing?.name ?? "";
            if (nameSource === "custom") {
              if (!name) {
                name = fallbackName;
              }
            } else {
              if (!name) {
                name = fallbackName;
              }
              if (hasPreview) {
                const nextName = previewThreadName(preview, name || fallbackName);
                if (nextName !== name) {
                  name = nextName;
                }
              }
            }

            if (
              !existing ||
              existing.name !== name ||
              existing.archived !== archived ||
              existing.nameSource !== nameSource
            ) {
              store.sessions[threadId] = { name, archived, nameSource };
              hasSessionUpdates = true;
            }
            return { id: threadId, name, archived };
          })
          .filter((entry): entry is ThreadSummary => Boolean(entry));

        const unique = new Map<string, ThreadSummary>();
        summaries.forEach((thread) => {
          if (!unique.has(thread.id)) {
            unique.set(thread.id, thread);
          }
        });
        sessionStoreByWorkspaceRef.current[workspace.id] = store;
        if (hasSessionUpdates) {
          await persistSessionStore(workspace.id, store);
        }
        dispatch({
          type: "setThreads",
          workspaceId: workspace.id,
          threads: Array.from(unique.values()),
        });
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-thread-list-error`,
          timestamp: Date.now(),
          source: "error",
          label: "thread/list error",
          payload: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [getSessionStore, onDebug, persistSessionStore],
  );

  const sendUserMessage = useCallback(
    async (text: string, attachments: LocalImageInput[] = []) => {
      if (!activeWorkspace) {
        return;
      }
      if (!text.trim() && attachments.length === 0) {
        return;
      }
      let threadId = activeThreadId;
      if (!threadId) {
        threadId = await startThread();
        if (!threadId) {
          return;
        }
      } else if (!loadedThreads.current[threadId]) {
        await resumeThreadForWorkspace(activeWorkspace.id, threadId);
      }

      const trimmedText = text.trim();
      if (!trimmedText && attachments.length === 0) {
        return;
      }
      dispatch({
        type: "addUserMessage",
        threadId,
        text: trimmedText,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
      if (trimmedText) {
        const fallbackName = getFallbackThreadName(activeWorkspace.id, threadId);
        const nextName = previewThreadName(trimmedText, fallbackName);
        void setDefaultThreadName(activeWorkspace.id, threadId, nextName);
      }
      dispatch({ type: "markCanceling", threadId, isCanceling: false });
      dispatch({ type: "markProcessing", threadId, isProcessing: true });
      try {
        void onMessageActivity?.();
      } catch {
        // Ignore refresh errors to avoid breaking the UI.
      }
      onDebug?.({
        id: `${Date.now()}-client-turn-start`,
        timestamp: Date.now(),
        source: "client",
        label: "turn/start",
        payload: {
          workspaceId: activeWorkspace.id,
          threadId,
          text: trimmedText,
          attachments: attachments.length,
          model,
          effort,
        },
      });
      try {
        const response = await sendUserMessageService(
          activeWorkspace.id,
          threadId,
          text,
          { model, effort, accessMode },
          attachments.length > 0 ? attachments : undefined,
        );
        onDebug?.({
          id: `${Date.now()}-server-turn-start`,
          timestamp: Date.now(),
          source: "server",
          label: "turn/start response",
          payload: response,
        });
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-turn-start-error`,
          timestamp: Date.now(),
          source: "error",
          label: "turn/start error",
          payload: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    [
      activeWorkspace,
      activeThreadId,
      effort,
      accessMode,
      getFallbackThreadName,
      model,
      onDebug,
      onMessageActivity,
      setDefaultThreadName,
      startThread,
    ],
  );

  const cancelActiveTurn = useCallback(async () => {
    if (!activeWorkspaceId || !activeThreadId) {
      return;
    }
    const status = state.threadStatusById[activeThreadId];
    if (!status?.isProcessing || status.isCanceling) {
      return;
    }
    dispatch({ type: "markCanceling", threadId: activeThreadId, isCanceling: true });
    onDebug?.({
      id: `${Date.now()}-client-turn-cancel`,
      timestamp: Date.now(),
      source: "client",
      label: "turn/cancel",
      payload: { workspaceId: activeWorkspaceId, threadId: activeThreadId },
    });
    try {
      const response = await cancelTurnService(activeWorkspaceId, activeThreadId);
      onDebug?.({
        id: `${Date.now()}-server-turn-cancel`,
        timestamp: Date.now(),
        source: "server",
        label: "turn/cancel response",
        payload: response,
      });
    } catch (error) {
      dispatch({
        type: "markCanceling",
        threadId: activeThreadId,
        isCanceling: false,
      });
      onDebug?.({
        id: `${Date.now()}-client-turn-cancel-error`,
        timestamp: Date.now(),
        source: "error",
        label: "turn/cancel error",
        payload: error instanceof Error ? error.message : String(error),
      });
    }
  }, [activeThreadId, activeWorkspaceId, onDebug, state.threadStatusById]);

  const startReview = useCallback(
    async (text: string) => {
      if (!activeWorkspace || !text.trim()) {
        return;
      }
      let threadId = activeThreadId;
      if (!threadId) {
        threadId = await startThread();
        if (!threadId) {
          return;
        }
      } else if (!loadedThreads.current[threadId]) {
        await resumeThreadForWorkspace(activeWorkspace.id, threadId);
      }

      const target = parseReviewTarget(text);
      dispatch({ type: "markCanceling", threadId, isCanceling: false });
      dispatch({ type: "markProcessing", threadId, isProcessing: true });
      dispatch({ type: "markReviewing", threadId, isReviewing: true });
      dispatch({
        type: "upsertItem",
        threadId,
        item: {
          id: `review-start-${threadId}-${Date.now()}`,
          kind: "review",
          state: "started",
          text: formatReviewLabel(target),
        },
      });
      try {
        void onMessageActivity?.();
      } catch {
        // Ignore refresh errors to avoid breaking the UI.
      }
      onDebug?.({
        id: `${Date.now()}-client-review-start`,
        timestamp: Date.now(),
        source: "client",
        label: "review/start",
        payload: {
          workspaceId: activeWorkspace.id,
          threadId,
          target,
        },
      });
      try {
        const response = await startReviewService(
          activeWorkspace.id,
          threadId,
          target,
          "inline",
        );
        onDebug?.({
          id: `${Date.now()}-server-review-start`,
          timestamp: Date.now(),
          source: "server",
          label: "review/start response",
          payload: response,
        });
      } catch (error) {
        dispatch({ type: "markProcessing", threadId, isProcessing: false });
        dispatch({ type: "markReviewing", threadId, isReviewing: false });
        onDebug?.({
          id: `${Date.now()}-client-review-start-error`,
          timestamp: Date.now(),
          source: "error",
          label: "review/start error",
          payload: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    [
      activeWorkspace,
      activeThreadId,
      onDebug,
      onMessageActivity,
      startThread,
      resumeThreadForWorkspace,
    ],
  );

  const handleApprovalDecision = useCallback(
    async (request: ApprovalRequest, decision: "accept" | "decline") => {
      await respondToServerRequest(
        request.workspace_id,
        request.request_id,
        decision,
      );
      dispatch({ type: "removeApproval", requestId: request.request_id });
    },
    [],
  );

  const setActiveThreadId = useCallback(
    (threadId: string | null, workspaceId?: string) => {
      const targetId = workspaceId ?? activeWorkspaceId;
      if (!targetId) {
        return;
      }
      dispatch({ type: "setActiveThreadId", workspaceId: targetId, threadId });
      if (threadId) {
        void resumeThreadForWorkspace(targetId, threadId, true);
      }
    },
    [activeWorkspaceId, resumeThreadForWorkspace],
  );

  const renameThread = useCallback(
    async (workspaceId: string, threadId: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) {
        return;
      }
      dispatch({ type: "setThreadName", workspaceId, threadId, name: trimmed });
      const store = await getSessionStore(workspaceId);
      const existing = store.sessions[threadId];
      const archived = existing?.archived ?? false;
      store.sessions[threadId] = {
        name: trimmed,
        archived,
        nameSource: "custom",
      };
      sessionStoreByWorkspaceRef.current[workspaceId] = store;
      await persistSessionStore(workspaceId, store);
    },
    [getSessionStore, persistSessionStore],
  );

  const setThreadArchived = useCallback(
    async (workspaceId: string, threadId: string, archived: boolean) => {
      dispatch({ type: "setThreadArchived", workspaceId, threadId, archived });
      const store = await getSessionStore(workspaceId);
      const existing = store.sessions[threadId];
      const nameSource = existing
        ? normalizeNameSource(existing.nameSource)
        : "default";
      const name = existing?.name?.trim()
        ? existing.name
        : getFallbackThreadName(workspaceId, threadId);
      store.sessions[threadId] = { name, archived, nameSource };
      sessionStoreByWorkspaceRef.current[workspaceId] = store;
      await persistSessionStore(workspaceId, store);
    },
    [getFallbackThreadName, getSessionStore, persistSessionStore],
  );

  const removeWorkspaceState = useCallback((workspaceId: string) => {
    dispatch({ type: "removeWorkspace", workspaceId });
    delete loadedThreads.current[workspaceId];
    delete threadsByWorkspaceRef.current[workspaceId];
    delete sessionStoreByWorkspaceRef.current[workspaceId];
  }, []);

  return {
    activeThreadId,
    setActiveThreadId,
    activeItems,
    approvals: state.approvals,
    threadsByWorkspace: state.threadsByWorkspace,
    threadStatusById: state.threadStatusById,
    renameThread,
    setThreadArchived,
    removeWorkspaceState,
    startThread,
    startThreadForWorkspace,
    listThreadsForWorkspace,
    sendUserMessage,
    cancelActiveTurn,
    startReview,
    handleApprovalDecision,
  };
}
