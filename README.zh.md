# CodexMonitor

Forked from https://github.com/Dimillian/CodexMonitor.git (MIT License). 本项目已发生分叉并产生差异。

[English](README.md) | [中文](README.zh.md)

![CodexMonitor](screenshot.png)

CodexMonitor 是一款 macOS Tauri 应用，用于在本地工作区编排多个 Codex agent。它提供侧边栏管理项目、主页快捷入口，以及基于 Codex app-server 协议的对话视图。

## 功能

### 工作区与会话
- 通过系统文件夹选择器添加工作区；信息持久化到应用数据目录（`workspaces.json`）。
- 每个工作区启动一个 `codex app-server`；应用启动时自动连接，窗口获得焦点时刷新线程列表。
- 线程按工作区 `cwd` 过滤，并在选中时执行恢复（resume）。
- 线程元数据按工作区保存到 `.codexmonitor/sessions.json`（名称 + 归档状态）。
- 支持重命名、归档/取消归档、复制线程 ID；线程状态徽标展示处理中/Review/未读。

### 对话与代理
- 新建线程并发送消息，支持选择模型与 reasoning effort。
- Access mode（read-only/current/full-access）映射到 sandbox 与 approval 策略。
- 审批请求在侧栏呈现并支持 accept/decline。
- Assistant 回复流式展示，并带有思考中提示。
- Tool 卡片展示 reasoning、命令执行输出、文件变更 diff、MCP tool call、web search、image view。

### Review
- `/review` 支持当前改动、基准分支、指定 commit 或自定义指令。
- Review 状态会写入线程，同时运行时锁定输入框。

### Prompts 与 Skills
- 从 app-server 获取 skills 列表，一键插入 `$skill`。
- 从 `~/.codex/prompts` 加载 prompt，支持 `/prompts:` 斜杠菜单。
- Prompt 模板支持 `$ARGUMENTS`、`$1` 和 `$var`。

### 附件
- 粘贴/拖拽/释放图片；文件保存到 `.codex/attachments`。
- 输入框预览图片，并在聊天记录中展示。

### Git
- Git 状态面板显示分支名、文件状态与 +/- 统计（libgit2）。
- 可查看选中文件的完整 diff；file-change tool 输出内联 diff。

### 应用体验
- 侧边栏可拖拽调整宽度；工作区展开/折叠状态持久化到设置中。
- 可选完成通知（点击打开对应线程）。
- 设置窗口（主题、默认 access mode、退出确认、绕过审批/沙箱、web search 开关）。
- macOS overlay 标题栏与毛玻璃效果；退出确认弹窗。
- Debug 面板展示告警/错误，支持复制与清空。

## 环境要求

- Node.js + npm
- Rust toolchain（stable）
- 已安装 Codex，并能通过 `PATH` 使用 `codex`

如果 `codex` 不在 `PATH` 中，需要在后端为每个工作区传入自定义路径。

## 快速开始

安装依赖：

```bash
npm install
```

开发模式运行：

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

## 项目结构

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

## 说明

- Workspaces persist to `workspaces.json` under the app data directory.
- Threads are restored by filtering `thread/list` results using the workspace `cwd`.
- Selecting a thread always calls `thread/resume` to refresh messages from disk.
- CLI sessions appear if their `cwd` matches the workspace path; they are not live-streamed unless resumed.
- The app uses `codex app-server` over stdio; see `src-tauri/src/lib.rs`.
