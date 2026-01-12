# CodexMonitor

Forked from https://github.com/Dimillian/CodexMonitor.git (MIT License). This project has diverged.

[English](README.md) | [中文](README.zh.md)

![CodexMonitor](screenshot.png)

CodexMonitor is a macOS Tauri app for orchestrating multiple Codex agents across local workspaces. It provides a sidebar to manage projects, a home screen for quick actions, and a conversation view backed by the Codex app-server protocol.

## Features

### Workspaces & Sessions
- Add workspaces via the system folder picker; persisted to app data (`workspaces.json`).
- One `codex app-server` per workspace; auto-connect on launch and refresh thread lists on focus.
- Threads are filtered by workspace `cwd` and resumed on selection.
- Thread metadata is persisted per workspace in `.codexmonitor/sessions.json` (names + archived state).
- Rename, archive/unarchive, and copy thread IDs; status badges for processing/reviewing/unread.

### Agent Chat
- Start new threads and send messages with model selection + reasoning effort.
- Access modes (read-only/current/full-access) map to sandbox + approval policies.
- Approval requests surfaced with accept/decline actions.
- Streaming assistant replies, with a thinking indicator.
- Tool cards for reasoning, command execution output, file change diffs, MCP tool calls, web search, and image view.

### Reviews
- `/review` command for current changes, base branch, commit, or custom instructions.
- Review state is surfaced in the thread and locks the composer while running.

### Prompts & Skills
- Skills list from app-server with one-click `$skill` insertion.
- Prompt library from `~/.codex/prompts` with `/prompts:` slash menu.
- Prompt template expansion supports `$ARGUMENTS`, `$1`, and `$var`.

### Attachments
- Paste/drag/drop images; stored under `.codex/attachments`.
- Image previews in the composer and rendered in chat history.

### Git
- Git status panel with branch name, per-file status, and +/- counts (libgit2).
- Full diff viewer for selected files; inline diffs for file-change tool output.

### App UX
- Resizable sidebar with per-workspace expand/collapse persisted in settings.
- Optional completion notifications (click to open the thread).
- Settings window (theme, default access mode, confirm-before-quit, bypass approvals/sandbox, web search flag).
- macOS overlay title bar with vibrancy effects; confirm-quit modal.
- Debug panel for warnings/errors with copy/clear.

## Requirements

- Node.js + npm
- Rust toolchain (stable)
- Codex installed on your system and available as `codex` in `PATH`

If the `codex` binary is not in `PATH`, update the backend to pass a custom path per workspace.

## Getting Started

Install dependencies:

```bash
npm install
```

Run in dev mode:

```bash
npm run tauri dev
```

## 打包（macOS）

一键构建通用架构 DMG：

```bash
npm run build:universal-dmg
```

产物目录：

```
src-tauri/target/universal-apple-darwin/release/bundle/dmg/
```

## Project Structure

```
src/
  components/       UI building blocks
  hooks/            state + event wiring
  services/         Tauri IPC wrapper
  styles/           split CSS by area
  types.ts          shared types
  src-tauri/
  src/lib.rs        Tauri backend + codex app-server client
  tauri.conf.json   window configuration
```

## Notes

- Workspaces persist to `workspaces.json` under the app data directory.
- Threads are restored by filtering `thread/list` results using the workspace `cwd`.
- Selecting a thread always calls `thread/resume` to refresh messages from disk.
- CLI sessions appear if their `cwd` matches the workspace path; they are not live-streamed unless resumed.
- The app uses `codex app-server` over stdio; see `src-tauri/src/lib.rs`.
