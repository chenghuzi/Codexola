import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AppSettings,
  LocalImageInput,
  UsageSnapshot,
  WorkspaceInfo,
  WorkspaceSessionStore,
} from "../types";
import type { GitFileDiff, GitFileStatus, ReviewTarget } from "../types";
import type { PromptFile, PromptOption } from "../types";

export async function pickWorkspacePath(): Promise<string | null> {
  const selection = await open({ directory: true, multiple: false });
  if (!selection || Array.isArray(selection)) {
    return null;
  }
  return selection;
}

export async function pickCodexBinPath(): Promise<string | null> {
  const selection = await open({ directory: false, multiple: false });
  if (!selection || Array.isArray(selection)) {
    return null;
  }
  return selection;
}

export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  return invoke<WorkspaceInfo[]>("list_workspaces");
}

export async function addWorkspace(
  path: string,
  codex_bin: string | null,
): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("add_workspace", { path, codex_bin });
}

export async function connectWorkspace(id: string): Promise<void> {
  return invoke("connect_workspace", { id });
}

export async function startThread(workspaceId: string) {
  return invoke<any>("start_thread", { workspaceId });
}

export async function sendUserMessage(
  workspaceId: string,
  threadId: string,
  text: string,
  options?: {
    model?: string | null;
    effort?: string | null;
    accessMode?: "read-only" | "current" | "full-access";
  },
  attachments?: LocalImageInput[],
) {
  return invoke("send_user_message", {
    workspaceId,
    threadId,
    text,
    model: options?.model ?? null,
    effort: options?.effort ?? null,
    accessMode: options?.accessMode ?? null,
    attachments: attachments && attachments.length > 0 ? attachments : null,
  });
}

export async function saveAttachment(
  workspaceId: string,
  payload: { bytes: number[]; name?: string | null; mime?: string | null },
): Promise<{ path: string }> {
  return invoke("save_attachment", {
    workspaceId,
    bytes: payload.bytes,
    name: payload.name ?? null,
    mime: payload.mime ?? null,
  });
}

export async function startReview(
  workspaceId: string,
  threadId: string,
  target: ReviewTarget,
  delivery?: "inline" | "detached",
) {
  const payload: Record<string, unknown> = { workspaceId, threadId, target };
  if (delivery) {
    payload.delivery = delivery;
  }
  return invoke("start_review", payload);
}

export async function respondToServerRequest(
  workspaceId: string,
  requestId: number,
  decision: "accept" | "decline",
) {
  return invoke("respond_to_server_request", {
    workspaceId,
    requestId,
    result: { decision },
  });
}

export async function getGitStatus(workspace_id: string): Promise<{
  branchName: string;
  files: GitFileStatus[];
  totalAdditions: number;
  totalDeletions: number;
}> {
  return invoke("get_git_status", { workspaceId: workspace_id });
}

export async function getGitDiffs(
  workspace_id: string,
): Promise<GitFileDiff[]> {
  return invoke("get_git_diffs", { workspaceId: workspace_id });
}

export async function getModelList(workspaceId: string) {
  return invoke<any>("model_list", { workspaceId });
}

export async function getSkillsList(workspaceId: string) {
  return invoke<any>("skills_list", { workspaceId });
}

export async function getPromptsList(): Promise<PromptOption[]> {
  return invoke<PromptOption[]>("prompts_list");
}

export async function readPrompt(name: string): Promise<PromptFile> {
  return invoke<PromptFile>("prompt_read", { name });
}

export async function searchFiles(
  workspaceId: string,
  query: string,
  limit?: number,
): Promise<string[]> {
  return invoke<string[]>("search_files", { workspaceId, query, limit });
}

export async function listThreads(
  workspaceId: string,
  cursor?: string | null,
  limit?: number | null,
) {
  return invoke<any>("list_threads", { workspaceId, cursor, limit });
}

export async function resumeThread(workspaceId: string, threadId: string) {
  return invoke<any>("resume_thread", { workspaceId, threadId });
}

export async function archiveThread(workspaceId: string, threadId: string) {
  return invoke<any>("archive_thread", { workspaceId, threadId });
}

export async function getWorkspaceSessions(
  workspaceId: string,
): Promise<WorkspaceSessionStore> {
  return invoke<WorkspaceSessionStore>("get_workspace_sessions", { workspaceId });
}

export async function saveWorkspaceSessions(
  workspaceId: string,
  sessions: WorkspaceSessionStore,
): Promise<WorkspaceSessionStore> {
  return invoke<WorkspaceSessionStore>("save_workspace_sessions", {
    workspaceId,
    sessions,
  });
}

export async function getSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_settings");
}

export async function updateSettings(settings: AppSettings): Promise<AppSettings> {
  return invoke<AppSettings>("update_settings", { settings });
}

export async function validateCodexBin(path: string): Promise<void> {
  return invoke("validate_codex_bin", { path });
}

export async function getUsageSnapshot(): Promise<UsageSnapshot> {
  return invoke<UsageSnapshot>("usage_get_snapshot");
}

export async function refreshUsageSnapshot(): Promise<UsageSnapshot> {
  return invoke<UsageSnapshot>("usage_refresh");
}

export async function confirmQuit(): Promise<void> {
  return invoke<void>("confirm_quit");
}
