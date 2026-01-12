use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use git2::{DiffOptions, Repository, Status, StatusOptions, Tree};
use tauri::{
    menu::{Menu, MenuItem, MenuItemKind},
    AppHandle, Emitter, Manager, State,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, oneshot};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone)]
struct GitFileStatus {
    path: String,
    status: String,
    additions: i64,
    deletions: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct GitFileDiff {
    path: String,
    diff: String,
}

#[derive(Debug, Deserialize, Clone)]
struct LocalImageInput {
    path: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PromptListItem {
    name: String,
    path: String,
    description: Option<String>,
    argument_hint: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PromptFile {
    name: String,
    body: String,
    description: Option<String>,
    argument_hint: Option<String>,
}

#[derive(Default)]
struct PromptFrontMatter {
    description: Option<String>,
    argument_hint: Option<String>,
}

fn normalize_git_path(path: &str) -> String {
    path.replace('\\', "/")
}

fn diff_stats_for_path(
    repo: &Repository,
    head_tree: Option<&Tree>,
    path: &str,
    include_index: bool,
    include_workdir: bool,
) -> Result<(i64, i64), git2::Error> {
    let mut additions = 0i64;
    let mut deletions = 0i64;

    if include_index {
        let mut options = DiffOptions::new();
        options.pathspec(path).include_untracked(true);
        let diff = repo.diff_tree_to_index(head_tree, None, Some(&mut options))?;
        let stats = diff.stats()?;
        additions += stats.insertions() as i64;
        deletions += stats.deletions() as i64;
    }

    if include_workdir {
        let mut options = DiffOptions::new();
        options
            .pathspec(path)
            .include_untracked(true)
            .recurse_untracked_dirs(true)
            .show_untracked_content(true);
        let diff = repo.diff_index_to_workdir(None, Some(&mut options))?;
        let stats = diff.stats()?;
        additions += stats.insertions() as i64;
        deletions += stats.deletions() as i64;
    }

    Ok((additions, deletions))
}

fn diff_patch_to_string(patch: &mut git2::Patch) -> Result<String, git2::Error> {
    let buf = patch.to_buf()?;
    Ok(buf
        .as_str()
        .map(|value| value.to_string())
        .unwrap_or_else(|| String::from_utf8_lossy(&buf).to_string()))
}

fn prompts_dir() -> Option<PathBuf> {
    if let Ok(value) = env::var("HOME") {
        if !value.trim().is_empty() {
            return Some(PathBuf::from(value).join(".codex").join("prompts"));
        }
    }
    if let Ok(value) = env::var("USERPROFILE") {
        if !value.trim().is_empty() {
            return Some(PathBuf::from(value).join(".codex").join("prompts"));
        }
    }
    None
}

fn parse_prompt_file(contents: &str) -> (PromptFrontMatter, String) {
    let mut front_matter = PromptFrontMatter::default();
    let mut lines = contents.lines();
    let first_line = match lines.next() {
        Some(line) => line.trim_end_matches('\r'),
        None => return (front_matter, String::new()),
    };
    if first_line != "---" {
        return (front_matter, contents.to_string());
    }

    let mut front_lines: Vec<String> = Vec::new();
    let mut body_start: Option<usize> = None;
    let mut offset = 0usize;
    for (index, line) in contents.split_inclusive('\n').enumerate() {
        let trimmed = line.trim_end_matches(&['\r', '\n'][..]);
        if index == 0 {
            offset += line.len();
            continue;
        }
        if trimmed == "---" {
            body_start = Some(offset + line.len());
            break;
        }
        front_lines.push(trimmed.to_string());
        offset += line.len();
    }

    if let Some(start) = body_start {
        for line in front_lines {
            if let Some((key, value)) = line.split_once(':') {
                let key = key.trim();
                let value = parse_prompt_value(value);
                match key {
                    "description" => front_matter.description = value,
                    "argument-hint" | "argument_hint" => {
                        front_matter.argument_hint = value
                    }
                    _ => {}
                }
            }
        }
        let body = contents.get(start..).unwrap_or_default().to_string();
        return (front_matter, body);
    }

    (front_matter, contents.to_string())
}

fn parse_prompt_value(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let unquoted = if (trimmed.starts_with('"') && trimmed.ends_with('"'))
        || (trimmed.starts_with('\'') && trimmed.ends_with('\''))
    {
        trimmed[1..trimmed.len() - 1].to_string()
    } else {
        trimmed.to_string()
    };
    Some(unquoted)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct WorkspaceEntry {
    id: String,
    name: String,
    path: String,
    codex_bin: Option<String>,
}

fn default_session_store_version() -> u32 {
    1
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "lowercase")]
enum SessionNameSource {
    Default,
    Custom,
}

impl Default for SessionNameSource {
    fn default() -> Self {
        SessionNameSource::Default
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionMetadata {
    #[serde(default)]
    name: String,
    #[serde(default)]
    archived: bool,
    #[serde(default)]
    name_source: SessionNameSource,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSessionStore {
    #[serde(default = "default_session_store_version")]
    version: u32,
    #[serde(default)]
    sessions: HashMap<String, SessionMetadata>,
}

impl Default for WorkspaceSessionStore {
    fn default() -> Self {
        Self {
            version: default_session_store_version(),
            sessions: HashMap::new(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "kebab-case")]
enum ThemePreference {
    System,
    Light,
    Dark,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "kebab-case")]
enum AccessMode {
    ReadOnly,
    Current,
    FullAccess,
}

fn default_sidebar_width() -> i64 {
    280
}

fn default_glass_blur_light() -> f64 {
    32.0
}

fn default_glass_blur_dark() -> f64 {
    32.0
}

fn default_glass_opacity_light() -> f64 {
    1.0
}

fn default_glass_opacity_dark() -> f64 {
    1.0
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    theme_preference: ThemePreference,
    access_mode: AccessMode,
    bypass_approvals_and_sandbox: bool,
    enable_web_search_request: bool,
    #[serde(default)]
    confirm_before_quit: bool,
    #[serde(default)]
    enable_completion_notifications: bool,
    #[serde(default = "default_sidebar_width")]
    sidebar_width: i64,
    #[serde(default = "default_glass_blur_light")]
    glass_blur_light: f64,
    #[serde(default = "default_glass_blur_dark")]
    glass_blur_dark: f64,
    #[serde(default = "default_glass_opacity_light")]
    glass_opacity_light: f64,
    #[serde(default = "default_glass_opacity_dark")]
    glass_opacity_dark: f64,
    #[serde(default)]
    workspace_sidebar_expanded: HashMap<String, bool>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme_preference: ThemePreference::System,
            access_mode: AccessMode::Current,
            bypass_approvals_and_sandbox: false,
            enable_web_search_request: false,
            confirm_before_quit: false,
            enable_completion_notifications: false,
            sidebar_width: default_sidebar_width(),
            glass_blur_light: default_glass_blur_light(),
            glass_blur_dark: default_glass_blur_dark(),
            glass_opacity_light: default_glass_opacity_light(),
            glass_opacity_dark: default_glass_opacity_dark(),
            workspace_sidebar_expanded: HashMap::new(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct WorkspaceInfo {
    id: String,
    name: String,
    path: String,
    connected: bool,
    codex_bin: Option<String>,
}

#[derive(Serialize, Clone)]
struct AppServerEvent {
    workspace_id: String,
    message: Value,
}

struct WorkspaceSession {
    entry: WorkspaceEntry,
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
}

impl WorkspaceSession {
    async fn write_message(&self, value: Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().await;
        let mut line = serde_json::to_string(&value).map_err(|e| e.to_string())?;
        line.push('\n');
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())
    }

    async fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        self.write_message(json!({ "id": id, "method": method, "params": params }))
            .await?;
        rx.await.map_err(|_| "request canceled".to_string())
    }

    async fn send_notification(&self, method: &str, params: Option<Value>) -> Result<(), String> {
        let value = if let Some(params) = params {
            json!({ "method": method, "params": params })
        } else {
            json!({ "method": method })
        };
        self.write_message(value).await
    }

    async fn send_response(&self, id: u64, result: Value) -> Result<(), String> {
        self.write_message(json!({ "id": id, "result": result }))
            .await
    }
}

struct AppState {
    workspaces: Mutex<HashMap<String, WorkspaceEntry>>,
    sessions: Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    storage_path: PathBuf,
    settings: Mutex<AppSettings>,
    settings_path: PathBuf,
    allow_quit: AtomicBool,
}

impl AppState {
    fn load(app: &AppHandle) -> Self {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| ".".into()))
            .to_path_buf();
        let storage_path = app_data_dir.join("workspaces.json");
        let settings_path = app_data_dir.join("settings.json");
        let workspaces = read_workspaces(&storage_path).unwrap_or_default();
        let settings = read_settings(&settings_path).unwrap_or_default();
        Self {
            workspaces: Mutex::new(workspaces),
            sessions: Mutex::new(HashMap::new()),
            storage_path,
            settings: Mutex::new(settings),
            settings_path,
            allow_quit: AtomicBool::new(false),
        }
    }
}

fn read_workspaces(path: &PathBuf) -> Result<HashMap<String, WorkspaceEntry>, String> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let data = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let list: Vec<WorkspaceEntry> = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    Ok(list.into_iter().map(|entry| (entry.id.clone(), entry)).collect())
}

fn write_workspaces(path: &PathBuf, entries: &[WorkspaceEntry]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
    std::fs::write(path, data).map_err(|e| e.to_string())
}

fn read_settings(path: &PathBuf) -> Result<AppSettings, String> {
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let data = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

fn write_settings(path: &PathBuf, settings: &AppSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, data).map_err(|e| e.to_string())
}

fn workspace_sessions_path(workspace_path: &str) -> PathBuf {
    PathBuf::from(workspace_path)
        .join(".codexmonitor")
        .join("sessions.json")
}

fn read_workspace_sessions(path: &PathBuf) -> Result<WorkspaceSessionStore, String> {
    if !path.exists() {
        return Ok(WorkspaceSessionStore::default());
    }
    let data = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

fn write_workspace_sessions(
    path: &PathBuf,
    sessions: &WorkspaceSessionStore,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(sessions).map_err(|e| e.to_string())?;
    std::fs::write(path, data).map_err(|e| e.to_string())
}

async fn spawn_workspace_session(
    entry: WorkspaceEntry,
    app_handle: AppHandle,
) -> Result<Arc<WorkspaceSession>, String> {
    let mut command = Command::new(entry.codex_bin.clone().unwrap_or_else(|| "codex".into()));
    let settings = {
        let state = app_handle.state::<AppState>();
        let settings = state.settings.lock().await.clone();
        settings
    };
    if settings.bypass_approvals_and_sandbox {
        command.arg("--dangerously-bypass-approvals-and-sandbox");
    }
    if settings.enable_web_search_request {
        command.arg("--enable").arg("web_search_request");
    }
    command.arg("app-server");
    command.stdin(std::process::Stdio::piped());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let stdin = child.stdin.take().ok_or("missing stdin")?;
    let stdout = child.stdout.take().ok_or("missing stdout")?;
    let stderr = child.stderr.take().ok_or("missing stderr")?;

    let session = Arc::new(WorkspaceSession {
        entry: entry.clone(),
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(1),
    });

    let session_clone = Arc::clone(&session);
    let workspace_id = entry.id.clone();
    let app_handle_clone = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let value: Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(err) => {
                    let payload = AppServerEvent {
                        workspace_id: workspace_id.clone(),
                        message: json!({
                            "method": "codex/parseError",
                            "params": { "error": err.to_string(), "raw": line },
                        }),
                    };
                    let _ = app_handle_clone.emit("app-server-event", payload);
                    continue;
                }
            };

            let maybe_id = value.get("id").and_then(|id| id.as_u64());
            let has_method = value.get("method").is_some();
            let has_result_or_error =
                value.get("result").is_some() || value.get("error").is_some();
            if let Some(id) = maybe_id {
                if has_result_or_error {
                    if let Some(tx) = session_clone.pending.lock().await.remove(&id) {
                        let _ = tx.send(value);
                    }
                } else if has_method {
                    let payload = AppServerEvent {
                        workspace_id: workspace_id.clone(),
                        message: value,
                    };
                    let _ = app_handle_clone.emit("app-server-event", payload);
                } else if let Some(tx) = session_clone.pending.lock().await.remove(&id) {
                    let _ = tx.send(value);
                }
            } else if has_method {
                let payload = AppServerEvent {
                    workspace_id: workspace_id.clone(),
                    message: value,
                };
                let _ = app_handle_clone.emit("app-server-event", payload);
            }
        }
    });

    let workspace_id = entry.id.clone();
    let app_handle_clone = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let payload = AppServerEvent {
                workspace_id: workspace_id.clone(),
                message: json!({
                    "method": "codex/stderr",
                    "params": { "message": line },
                }),
            };
            let _ = app_handle_clone.emit("app-server-event", payload);
        }
    });

    let init_params = json!({
        "clientInfo": {
            "name": "codex_monitor",
            "title": "CodexMonitor",
            "version": "0.1.0"
        }
    });
    session.send_request("initialize", init_params).await?;
    session.send_notification("initialized", None).await?;

    let payload = AppServerEvent {
        workspace_id: entry.id.clone(),
        message: json!({
            "method": "codex/connected",
            "params": { "workspaceId": entry.id.clone() }
        }),
    };
    let _ = app_handle.emit("app-server-event", payload);

    Ok(session)
}

#[tauri::command]
async fn list_workspaces(state: State<'_, AppState>) -> Result<Vec<WorkspaceInfo>, String> {
    let workspaces = state.workspaces.lock().await;
    let sessions = state.sessions.lock().await;
    let mut result = Vec::new();
    for entry in workspaces.values() {
        result.push(WorkspaceInfo {
            id: entry.id.clone(),
            name: entry.name.clone(),
            path: entry.path.clone(),
            codex_bin: entry.codex_bin.clone(),
            connected: sessions.contains_key(&entry.id),
        });
    }
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

#[tauri::command]
async fn add_workspace(
    path: String,
    codex_bin: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<WorkspaceInfo, String> {
    let name = PathBuf::from(&path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Workspace")
        .to_string();
    let entry = WorkspaceEntry {
        id: Uuid::new_v4().to_string(),
        name: name.clone(),
        path: path.clone(),
        codex_bin,
    };

    let session = spawn_workspace_session(entry.clone(), app).await?;
    {
        let mut workspaces = state.workspaces.lock().await;
        workspaces.insert(entry.id.clone(), entry.clone());
        let list: Vec<_> = workspaces.values().cloned().collect();
        write_workspaces(&state.storage_path, &list)?;
    }
    state
        .sessions
        .lock()
        .await
        .insert(entry.id.clone(), session);

    Ok(WorkspaceInfo {
        id: entry.id,
        name: entry.name,
        path: entry.path,
        codex_bin: entry.codex_bin,
        connected: true,
    })
}

#[tauri::command]
async fn remove_workspace(
    id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut workspaces = state.workspaces.lock().await;
        workspaces.remove(&id);
        let list: Vec<_> = workspaces.values().cloned().collect();
        write_workspaces(&state.storage_path, &list)?;
    }

    if let Some(session) = state.sessions.lock().await.remove(&id) {
        let mut child = session.child.lock().await;
        let _ = child.kill().await;
    }

    Ok(())
}

#[tauri::command]
async fn start_thread(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&workspace_id)
        .ok_or("workspace not connected")?;
    let params = json!({
        "cwd": session.entry.path,
        "approvalPolicy": "on-request"
    });
    session.send_request("thread/start", params).await
}

#[tauri::command]
async fn resume_thread(
    workspace_id: String,
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&workspace_id)
        .ok_or("workspace not connected")?;
    let params = json!({
        "threadId": thread_id
    });
    session.send_request("thread/resume", params).await
}

#[tauri::command]
async fn list_threads(
    workspace_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&workspace_id)
        .ok_or("workspace not connected")?;
    let params = json!({
        "cursor": cursor,
        "limit": limit,
    });
    session.send_request("thread/list", params).await
}

#[tauri::command]
async fn archive_thread(
    workspace_id: String,
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&workspace_id)
        .ok_or("workspace not connected")?;
    let params = json!({
        "threadId": thread_id
    });
    session.send_request("thread/archive", params).await
}

#[tauri::command]
async fn get_workspace_sessions(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<WorkspaceSessionStore, String> {
    let workspaces = state.workspaces.lock().await;
    let entry = workspaces
        .get(&workspace_id)
        .ok_or("workspace not found")?;
    let path = workspace_sessions_path(&entry.path);
    read_workspace_sessions(&path)
}

#[tauri::command]
async fn save_workspace_sessions(
    workspace_id: String,
    sessions: WorkspaceSessionStore,
    state: State<'_, AppState>,
) -> Result<WorkspaceSessionStore, String> {
    let workspaces = state.workspaces.lock().await;
    let entry = workspaces
        .get(&workspace_id)
        .ok_or("workspace not found")?;
    let path = workspace_sessions_path(&entry.path);
    let mut store = sessions;
    if store.version == 0 {
        store.version = default_session_store_version();
    }
    write_workspace_sessions(&path, &store)?;
    Ok(store)
}

#[tauri::command]
async fn save_attachment(
    workspace_id: String,
    bytes: Vec<u8>,
    name: Option<String>,
    mime: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    if bytes.is_empty() {
        return Err("empty attachment".to_string());
    }
    let workspaces = state.workspaces.lock().await;
    let entry = workspaces
        .get(&workspace_id)
        .ok_or("workspace not found")?;
    let mut dir = PathBuf::from(&entry.path);
    dir.push(".codex");
    dir.push("attachments");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let name_ext = name
        .as_deref()
        .and_then(|value| Path::new(value).extension())
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_lowercase());
    let mime_ext = mime.as_deref().and_then(|value| match value {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/jpg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "image/heic" => Some("heic"),
        "image/heif" => Some("heif"),
        "image/bmp" => Some("bmp"),
        "image/tiff" => Some("tiff"),
        _ => None,
    });
    let extension = name_ext
        .as_deref()
        .or(mime_ext)
        .unwrap_or("img");

    let filename = format!("{}.{}", Uuid::new_v4(), extension);
    let mut path = dir.clone();
    path.push(filename);
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(json!({ "path": path.to_string_lossy().to_string() }))
}

#[tauri::command]
async fn send_user_message(
    workspace_id: String,
    thread_id: String,
    text: String,
    model: Option<String>,
    effort: Option<String>,
    access_mode: Option<String>,
    attachments: Option<Vec<LocalImageInput>>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&workspace_id)
        .ok_or("workspace not connected")?;
    let access_mode = access_mode.unwrap_or_else(|| "current".to_string());
    let sandbox_policy = match access_mode.as_str() {
        "full-access" => json!({
            "type": "dangerFullAccess"
        }),
        "read-only" => json!({
            "type": "readOnly"
        }),
        _ => json!({
            "type": "workspaceWrite",
            "writableRoots": [session.entry.path],
            "networkAccess": true
        }),
    };

    let approval_policy = if access_mode == "full-access" {
        "never"
    } else {
        "on-request"
    };

    let mut input: Vec<Value> = Vec::new();
    if !text.trim().is_empty() {
        input.push(json!({ "type": "text", "text": text }));
    }
    if let Some(attachments) = attachments {
        for attachment in attachments {
            if !attachment.path.trim().is_empty() {
                input.push(json!({ "type": "localImage", "path": attachment.path }));
            }
        }
    }
    if input.is_empty() {
        return Err("empty input".to_string());
    }

    let params = json!({
        "threadId": thread_id,
        "input": input,
        "cwd": session.entry.path,
        "approvalPolicy": approval_policy,
        "sandboxPolicy": sandbox_policy,
        "model": model,
        "effort": effort,
    });
    session.send_request("turn/start", params).await
}

#[tauri::command]
async fn start_review(
    workspace_id: String,
    thread_id: String,
    target: Value,
    delivery: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&workspace_id)
        .ok_or("workspace not connected")?;
    let mut params = Map::new();
    params.insert("threadId".to_string(), json!(thread_id));
    params.insert("target".to_string(), target);
    if let Some(delivery) = delivery {
        params.insert("delivery".to_string(), json!(delivery));
    }
    session
        .send_request("review/start", Value::Object(params))
        .await
}
#[tauri::command]
async fn model_list(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&workspace_id)
        .ok_or("workspace not connected")?;
    let params = json!({});
    session.send_request("model/list", params).await
}

#[tauri::command]
async fn skills_list(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&workspace_id)
        .ok_or("workspace not connected")?;
    let params = json!({
        "cwd": session.entry.path
    });
    session.send_request("skills/list", params).await
}

#[tauri::command]
async fn prompts_list() -> Result<Vec<PromptListItem>, String> {
    let Some(dir) = prompts_dir() else {
        return Ok(Vec::new());
    };
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut items: Vec<PromptListItem> = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        let name = match path.file_stem().and_then(|stem| stem.to_str()) {
            Some(value) if !value.trim().is_empty() => value.to_string(),
            _ => continue,
        };
        let contents = match fs::read_to_string(&path) {
            Ok(contents) => contents,
            Err(_) => continue,
        };
        let (meta, _body) = parse_prompt_file(&contents);
        items.push(PromptListItem {
            name,
            path: path.to_string_lossy().to_string(),
            description: meta.description,
            argument_hint: meta.argument_hint,
        });
    }
    items.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(items)
}

#[tauri::command]
async fn prompt_read(name: String) -> Result<PromptFile, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("prompt name is empty".to_string());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("invalid prompt name".to_string());
    }
    let dir = prompts_dir().ok_or("prompt directory unavailable")?;
    let path = dir.join(format!("{name}.md"));
    let contents = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let (meta, body) = parse_prompt_file(&contents);
    Ok(PromptFile {
        name: name.to_string(),
        body,
        description: meta.description,
        argument_hint: meta.argument_hint,
    })
}

#[tauri::command]
async fn respond_to_server_request(
    workspace_id: String,
    request_id: u64,
    result: Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&workspace_id)
        .ok_or("workspace not connected")?;
    session.send_response(request_id, result).await
}

#[tauri::command]
async fn connect_workspace(
    id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let entry = {
        let workspaces = state.workspaces.lock().await;
        workspaces
            .get(&id)
            .cloned()
            .ok_or("workspace not found")?
    };

    let session = spawn_workspace_session(entry.clone(), app).await?;
    state.sessions.lock().await.insert(entry.id, session);
    Ok(())
}

#[tauri::command]
async fn get_git_status(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let workspaces = state.workspaces.lock().await;
    let entry = workspaces
        .get(&workspace_id)
        .ok_or("workspace not found")?
        .clone();

    let repo = Repository::open(&entry.path).map_err(|e| e.to_string())?;

    let branch_name = repo
        .head()
        .ok()
        .and_then(|head| head.shorthand().map(|s| s.to_string()))
        .unwrap_or_else(|| "unknown".to_string());

    let mut status_options = StatusOptions::new();
    status_options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true)
        .include_ignored(false);

    let statuses = repo
        .statuses(Some(&mut status_options))
        .map_err(|e| e.to_string())?;

    let head_tree = repo.head().ok().and_then(|head| head.peel_to_tree().ok());

    let mut files = Vec::new();
    let mut total_additions = 0i64;
    let mut total_deletions = 0i64;
    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("");
        if path.is_empty() {
            continue;
        }
        let status = entry.status();
        let status_str = if status.contains(Status::WT_NEW) || status.contains(Status::INDEX_NEW) {
            "A"
        } else if status.contains(Status::WT_MODIFIED) || status.contains(Status::INDEX_MODIFIED) {
            "M"
        } else if status.contains(Status::WT_DELETED) || status.contains(Status::INDEX_DELETED) {
            "D"
        } else if status.contains(Status::WT_RENAMED) || status.contains(Status::INDEX_RENAMED) {
            "R"
        } else if status.contains(Status::WT_TYPECHANGE) || status.contains(Status::INDEX_TYPECHANGE) {
            "T"
        } else {
            "--"
        };
        let normalized_path = normalize_git_path(path);
        let include_index = status.intersects(
            Status::INDEX_NEW
                | Status::INDEX_MODIFIED
                | Status::INDEX_DELETED
                | Status::INDEX_RENAMED
                | Status::INDEX_TYPECHANGE,
        );
        let include_workdir = status.intersects(
            Status::WT_NEW
                | Status::WT_MODIFIED
                | Status::WT_DELETED
                | Status::WT_RENAMED
                | Status::WT_TYPECHANGE,
        );
        let (additions, deletions) = diff_stats_for_path(
            &repo,
            head_tree.as_ref(),
            path,
            include_index,
            include_workdir,
        )
        .map_err(|e| e.to_string())?;
        total_additions += additions;
        total_deletions += deletions;
        files.push(GitFileStatus {
            path: normalized_path,
            status: status_str.to_string(),
            additions,
            deletions,
        });
    }

    Ok(json!({
        "branchName": branch_name,
        "files": files,
        "totalAdditions": total_additions,
        "totalDeletions": total_deletions,
    }))
}

#[tauri::command]
async fn get_git_diffs(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<GitFileDiff>, String> {
    let workspaces = state.workspaces.lock().await;
    let entry = workspaces
        .get(&workspace_id)
        .ok_or("workspace not found")?
        .clone();

    let repo = Repository::open(&entry.path).map_err(|e| e.to_string())?;
    let head_tree = repo
        .head()
        .ok()
        .and_then(|head| head.peel_to_tree().ok());

    let mut options = DiffOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);

    let diff = match head_tree.as_ref() {
        Some(tree) => repo
            .diff_tree_to_workdir_with_index(Some(tree), Some(&mut options))
            .map_err(|e| e.to_string())?,
        None => repo
            .diff_tree_to_workdir_with_index(None, Some(&mut options))
            .map_err(|e| e.to_string())?,
    };

    let mut results = Vec::new();
    for (index, delta) in diff.deltas().enumerate() {
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path());
        let Some(path) = path else {
            continue;
        };
        let patch = match git2::Patch::from_diff(&diff, index) {
            Ok(patch) => patch,
            Err(_) => continue,
        };
        let Some(mut patch) = patch else {
            continue;
        };
        let content = match diff_patch_to_string(&mut patch) {
            Ok(content) => content,
            Err(_) => continue,
        };
        if content.trim().is_empty() {
            continue;
        }
        results.push(GitFileDiff {
            path: normalize_git_path(path.to_string_lossy().as_ref()),
            diff: content,
        });
    }

    Ok(results)
}

#[cfg(target_os = "macos")]
fn insert_preferences_menu_item<R: tauri::Runtime>(
    app: &AppHandle<R>,
    menu: &Menu<R>,
) -> tauri::Result<()> {
    let app_name = app.package_info().name.clone();
    let submenu = menu.items()?.into_iter().find_map(|item| match item {
        MenuItemKind::Submenu(submenu) => match submenu.text() {
            Ok(text) if text == app_name => Some(submenu),
            _ => None,
        },
        _ => None,
    });
    if let Some(submenu) = submenu {
        let preferences_item =
            MenuItem::with_id(app, "preferences", "Preferences...", true, Some("CmdOrCtrl+,"))?;
        submenu.insert(&preferences_item, 1)?;
        let items = submenu.items()?;
        let mut quit_index = None;
        let mut quit_label = None;
        for (index, item) in items.iter().enumerate() {
            if let Some(predefined) = item.as_predefined_menuitem() {
                if let Ok(text) = predefined.text() {
                    if text == format!("Quit {}", app_name) {
                        quit_index = Some(index);
                        quit_label = Some(text);
                        break;
                    }
                }
            }
        }
        if quit_index.is_none() {
            for index in (0..items.len()).rev() {
                let item = &items[index];
                if let Some(predefined) = item.as_predefined_menuitem() {
                    if let Ok(text) = predefined.text() {
                        quit_index = Some(index);
                        quit_label = Some(text);
                        break;
                    }
                }
            }
        }
        if let Some(index) = quit_index {
            let _ = submenu.remove_at(index);
            let quit_label = quit_label.unwrap_or_else(|| format!("Quit {}", app_name));
            let quit_item = MenuItem::with_id(
                app,
                "quit",
                quit_label,
                true,
                Some("CmdOrCtrl+Q"),
            )?;
            submenu.insert(&quit_item, index)?;
        }
    }
    Ok(())
}

fn open_settings_window<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let url = tauri::WebviewUrl::App("index.html#/settings".into());
    let window = tauri::WebviewWindowBuilder::new(app, "settings", url)
        .title("Settings")
        .inner_size(760.0, 520.0)
        .min_inner_size(680.0, 480.0)
        .resizable(false)
        .maximizable(false)
        .transparent(true)
        .decorations(true)
        .title_bar_style(tauri::TitleBarStyle::Visible)
        .build()
        .map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

fn should_confirm_quit(state: &AppState) -> bool {
    if state.allow_quit.load(Ordering::SeqCst) {
        return false;
    }
    let settings = tauri::async_runtime::block_on(async { state.settings.lock().await.clone() });
    settings.confirm_before_quit
}

fn emit_confirm_quit<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("confirm-quit", ());
    } else {
        let _ = app.emit("confirm-quit", ());
    }
}

fn handle_quit_request<R: tauri::Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    if should_confirm_quit(&state) {
        emit_confirm_quit(app);
    } else {
        app.exit(0);
    }
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    Ok(state.settings.lock().await.clone())
}

#[tauri::command]
async fn update_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    {
        let mut guard = state.settings.lock().await;
        *guard = settings.clone();
        write_settings(&state.settings_path, &settings)?;
    }
    let _ = app.emit("settings-updated", settings.clone());
    Ok(settings)
}

#[tauri::command]
async fn confirm_quit(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.allow_quit.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .enable_macos_default_menu(true)
        .menu(|app| {
            let menu = Menu::default(app)?;
            #[cfg(target_os = "macos")]
            insert_preferences_menu_item(app, &menu)?;
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id() == "preferences" {
                let _ = open_settings_window(app);
            }
            if event.id() == "quit" {
                handle_quit_request(app);
            }
        })
        .setup(|app| {
            let state = AppState::load(&app.handle());
            app.manage(state);
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            list_workspaces,
            add_workspace,
            remove_workspace,
            start_thread,
            save_attachment,
            send_user_message,
            start_review,
            respond_to_server_request,
            resume_thread,
            list_threads,
            archive_thread,
            get_workspace_sessions,
            save_workspace_sessions,
            connect_workspace,
            get_git_status,
            get_git_diffs,
            model_list,
            skills_list,
            prompts_list,
            prompt_read,
            get_settings,
            update_settings,
            confirm_quit
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            let state = app_handle.state::<AppState>();
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if should_confirm_quit(&state) {
                    api.prevent_exit();
                    emit_confirm_quit(&app_handle);
                }
                return;
            }

            if let tauri::RunEvent::WindowEvent { label, event, .. } = event {
                if label != "main" {
                    return;
                }
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if should_confirm_quit(&state) {
                        api.prevent_close();
                        emit_confirm_quit(&app_handle);
                    }
                }
            }
        });
}
