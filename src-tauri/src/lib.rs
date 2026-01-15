use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{BufRead, BufReader as StdBufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use chrono::DateTime;
use git2::{DiffOptions, Repository, Status, StatusOptions, Tree};
use ignore::WalkBuilder;
use tauri::{
    menu::{Menu, MenuItem, MenuItemKind},
    AppHandle, Emitter, Manager, State,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, oneshot};
use tokio::task::JoinHandle;
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

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn is_excluded_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| matches!(name, ".git" | ".codex" | "node_modules"))
        .unwrap_or(false)
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

fn default_usage_polling_enabled() -> bool {
    true
}

fn default_usage_polling_interval_minutes() -> i64 {
    5
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
    #[serde(default = "default_usage_polling_enabled")]
    usage_polling_enabled: bool,
    #[serde(default = "default_usage_polling_interval_minutes")]
    usage_polling_interval_minutes: i64,
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
    codex_bin_path: Option<String>,
    #[serde(default)]
    node_bin_path: Option<String>,
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
            usage_polling_enabled: default_usage_polling_enabled(),
            usage_polling_interval_minutes: default_usage_polling_interval_minutes(),
            sidebar_width: default_sidebar_width(),
            glass_blur_light: default_glass_blur_light(),
            glass_blur_dark: default_glass_blur_dark(),
            glass_opacity_light: default_glass_opacity_light(),
            glass_opacity_dark: default_glass_opacity_dark(),
            codex_bin_path: None,
            node_bin_path: None,
            workspace_sidebar_expanded: HashMap::new(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "kebab-case")]
enum UsageSource {
    None,
    AppServer,
    Sessions,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UsagePoint {
    timestamp_ms: i64,
    tokens: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UsageSnapshot {
    total_tokens_24h: Option<i64>,
    updated_at_ms: Option<i64>,
    source: UsageSource,
    rate_limits: Option<RateLimitSnapshot>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UsageStore {
    #[serde(default)]
    app_server_points: Vec<UsagePoint>,
    #[serde(default)]
    last_snapshot: Option<UsageSnapshot>,
    #[serde(default)]
    last_rate_limits: Option<RateLimitSnapshot>,
}

impl Default for UsageStore {
    fn default() -> Self {
        Self {
            app_server_points: Vec::new(),
            last_snapshot: None,
            last_rate_limits: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RateLimitWindow {
    used_percent: i64,
    window_duration_mins: Option<i64>,
    resets_at: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RateLimitSnapshot {
    primary: Option<RateLimitWindow>,
    secondary: Option<RateLimitWindow>,
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
    usage_store: Mutex<UsageStore>,
    usage_path: PathBuf,
    usage_poll_handle: Mutex<Option<JoinHandle<()>>>,
    usage_probe_inflight: AtomicBool,
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
        let usage_path = app_data_dir.join("usage.json");
        let workspaces = read_workspaces(&storage_path).unwrap_or_default();
        let settings = read_settings(&settings_path).unwrap_or_default();
        let usage_store = read_usage_store(&usage_path).unwrap_or_default();
        Self {
            workspaces: Mutex::new(workspaces),
            sessions: Mutex::new(HashMap::new()),
            storage_path,
            settings: Mutex::new(settings),
            settings_path,
            allow_quit: AtomicBool::new(false),
            usage_store: Mutex::new(usage_store),
            usage_path,
            usage_poll_handle: Mutex::new(None),
            usage_probe_inflight: AtomicBool::new(false),
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

fn read_usage_store(path: &PathBuf) -> Result<UsageStore, String> {
    if !path.exists() {
        return Ok(UsageStore::default());
    }
    let data = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

fn write_usage_store(path: &PathBuf, store: &UsageStore) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(path, data).map_err(|e| e.to_string())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis() as i64
}

fn cutoff_ms(now: i64) -> i64 {
    now.saturating_sub(24 * 60 * 60 * 1000)
}

fn prune_points(points: &mut Vec<UsagePoint>, cutoff: i64) {
    points.retain(|point| point.timestamp_ms >= cutoff);
}

fn sum_points(points: &[UsagePoint]) -> i64 {
    points.iter().map(|point| point.tokens).sum()
}

fn empty_usage_snapshot() -> UsageSnapshot {
    UsageSnapshot {
        total_tokens_24h: None,
        updated_at_ms: None,
        source: UsageSource::None,
        rate_limits: None,
    }
}

fn parse_rfc3339_ms(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

fn system_time_ms(value: SystemTime) -> Option<i64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as i64)
}

fn resolve_codex_home() -> Option<PathBuf> {
    if let Ok(value) = env::var("CODEX_HOME") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    if let Ok(value) = env::var("HOME") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed).join(".codex"));
        }
    }
    if let Ok(value) = env::var("USERPROFILE") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed).join(".codex"));
        }
    }
    None
}

fn parse_token_count_from_rollout(value: &Value) -> Option<i64> {
    let item_type = value.get("type")?.as_str()?;
    if item_type != "event_msg" {
        return None;
    }
    let payload = value.get("payload")?;
    let payload_type = payload.get("type")?.as_str()?;
    if payload_type != "token_count" {
        return None;
    }
    let info = payload.get("info")?;
    let last_usage = info
        .get("last_token_usage")
        .or_else(|| info.get("lastTokenUsage"))?;
    let total_tokens = last_usage
        .get("total_tokens")
        .or_else(|| last_usage.get("totalTokens"))?
        .as_i64()?;
    if total_tokens > 0 {
        Some(total_tokens)
    } else {
        None
    }
}

fn parse_used_percent(value: &Value) -> Option<i64> {
    if let Some(int) = value.as_i64() {
        return Some(int);
    }
    value.as_f64().map(|float| float.round() as i64)
}

fn parse_rate_limit_window(value: &Value) -> Option<RateLimitWindow> {
    let used_percent = value
        .get("usedPercent")
        .or_else(|| value.get("used_percent"))
        .and_then(parse_used_percent)?;
    let window_duration_mins = value
        .get("windowDurationMins")
        .or_else(|| value.get("window_duration_mins"))
        .and_then(|value| value.as_i64());
    let resets_at = value
        .get("resetsAt")
        .or_else(|| value.get("resets_at"))
        .and_then(|value| value.as_i64());
    Some(RateLimitWindow {
        used_percent,
        window_duration_mins,
        resets_at,
    })
}

fn parse_rate_limits_from_container(container: &Value) -> Option<RateLimitSnapshot> {
    let rate_limits = container
        .get("rateLimits")
        .or_else(|| container.get("rate_limits"))?;
    let primary = rate_limits
        .get("primary")
        .and_then(|value| parse_rate_limit_window(value));
    let secondary = rate_limits
        .get("secondary")
        .and_then(|value| parse_rate_limit_window(value));
    Some(RateLimitSnapshot { primary, secondary })
}

fn scan_session_tokens_24h(codex_home: &Path, cutoff: i64) -> Result<Option<i64>, String> {
    let sessions_dir = codex_home.join("sessions");
    if !sessions_dir.exists() {
        return Ok(None);
    }

    let mut total_tokens: i64 = 0;
    let walker = WalkBuilder::new(&sessions_dir)
        .follow_links(false)
        .max_depth(Some(6))
        .build();

    for entry in walker {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !entry
            .file_type()
            .map(|file_type| file_type.is_file())
            .unwrap_or(false)
        {
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        if let Ok(metadata) = entry.metadata() {
            if let Some(modified_ms) = metadata.modified().ok().and_then(system_time_ms) {
                if modified_ms < cutoff {
                    continue;
                }
            }
        }

        let file = fs::File::open(path).map_err(|e| e.to_string())?;
        let reader = StdBufReader::new(file);
        for line in reader.lines() {
            let line = line.map_err(|e| e.to_string())?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let value: Value = match serde_json::from_str(trimmed) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let timestamp = value
                .get("timestamp")
                .and_then(|ts| ts.as_str())
                .and_then(parse_rfc3339_ms);
            if let Some(timestamp_ms) = timestamp {
                if timestamp_ms < cutoff {
                    continue;
                }
            } else {
                continue;
            }

            if let Some(tokens) = parse_token_count_from_rollout(&value) {
                total_tokens += tokens;
            }
        }
    }

    Ok(Some(total_tokens))
}

fn extract_app_server_token_delta(message: &Value) -> Option<i64> {
    let params = message.get("params")?;
    let token_usage = params.get("tokenUsage").or_else(|| params.get("token_usage"))?;
    let last_usage = token_usage.get("last").or_else(|| token_usage.get("last_usage"))?;
    let total_tokens = last_usage
        .get("totalTokens")
        .or_else(|| last_usage.get("total_tokens"))?
        .as_i64()?;
    if total_tokens > 0 {
        Some(total_tokens)
    } else {
        None
    }
}

async fn emit_usage_snapshot(app: &AppHandle, snapshot: UsageSnapshot) {
    let _ = app.emit("usage-updated", snapshot);
}

async fn record_app_server_usage(app: &AppHandle, tokens: i64) -> Result<UsageSnapshot, String> {
    let state = app.state::<AppState>();
    let now = now_ms();
    let cutoff = cutoff_ms(now);

    let mut store = state.usage_store.lock().await;
    store.app_server_points.push(UsagePoint {
        timestamp_ms: now,
        tokens,
    });
    prune_points(&mut store.app_server_points, cutoff);
    let total = sum_points(&store.app_server_points);
    let rate_limits = store.last_rate_limits.clone();

    let snapshot = UsageSnapshot {
        total_tokens_24h: Some(total),
        updated_at_ms: Some(now),
        source: UsageSource::AppServer,
        rate_limits,
    };
    store.last_snapshot = Some(snapshot.clone());
    write_usage_store(&state.usage_path, &store)?;
    drop(store);

    emit_usage_snapshot(app, snapshot.clone()).await;
    Ok(snapshot)
}

async fn record_rate_limits(
    app: &AppHandle,
    rate_limits: RateLimitSnapshot,
) -> Result<UsageSnapshot, String> {
    let state = app.state::<AppState>();
    let now = now_ms();
    let cutoff = cutoff_ms(now);
    let mut store = state.usage_store.lock().await;
    prune_points(&mut store.app_server_points, cutoff);
    store.last_rate_limits = Some(rate_limits.clone());
    let total_tokens_24h = if !store.app_server_points.is_empty() {
        Some(sum_points(&store.app_server_points))
    } else {
        store.last_snapshot.as_ref().and_then(|snapshot| snapshot.total_tokens_24h)
    };
    let snapshot = UsageSnapshot {
        total_tokens_24h,
        updated_at_ms: Some(now),
        source: UsageSource::AppServer,
        rate_limits: Some(rate_limits),
    };
    store.last_snapshot = Some(snapshot.clone());
    write_usage_store(&state.usage_path, &store)?;
    drop(store);
    emit_usage_snapshot(app, snapshot.clone()).await;
    Ok(snapshot)
}

async fn fetch_rate_limits_via_app_server(
    codex_bin: String,
    settings: AppSettings,
) -> Result<Option<RateLimitSnapshot>, String> {
    let mut command = Command::new(codex_bin);
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
    let mut stdin = child.stdin.take().ok_or("missing stdin")?;
    let stdout = child.stdout.take().ok_or("missing stdout")?;
    let stderr = child.stderr.take().ok_or("missing stderr")?;

    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(_)) = lines.next_line().await {}
    });

    let mut lines = BufReader::new(stdout).lines();
    let init = json!({
        "id": 1,
        "method": "initialize",
        "params": { "clientInfo": { "name": "codexola", "version": "0.1.0" } }
    });
    let mut line = serde_json::to_string(&init).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
    let initialized = json!({ "method": "initialized" });
    let mut line = serde_json::to_string(&initialized).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;

    let request = json!({
        "id": 2,
        "method": "account/rateLimits/read",
        "params": {}
    });
    let mut line = serde_json::to_string(&request).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;

    let mut result: Option<RateLimitSnapshot> = None;
    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let id = value.get("id").and_then(|id| id.as_i64());
        if id == Some(2) {
            if value.get("error").is_some() {
                break;
            }
            let result_value = value.get("result").cloned().unwrap_or_default();
            result = parse_rate_limits_from_container(&result_value);
            break;
        }
    }

    let _ = child.kill().await;
    let _ = child.wait().await;
    Ok(result)
}

async fn probe_rate_limits_via_temp_app_server(
    app: &AppHandle,
) -> Result<Option<RateLimitSnapshot>, String> {
    let state = app.state::<AppState>();
    if state
        .usage_probe_inflight
        .swap(true, Ordering::SeqCst)
    {
        return Ok(None);
    }

    let settings = state.settings.lock().await.clone();
    let codex_bin = {
        let workspaces = state.workspaces.lock().await;
        workspaces
            .values()
            .find_map(|entry| entry.codex_bin.clone())
            .unwrap_or_else(|| "codex".to_string())
    };
    let result = fetch_rate_limits_via_app_server(codex_bin, settings).await;
    state.usage_probe_inflight.store(false, Ordering::SeqCst);
    result
}

async fn fetch_rate_limits_from_any_session(
    state: &AppState,
) -> Result<Option<RateLimitSnapshot>, String> {
    let session = {
        let sessions = state.sessions.lock().await;
        sessions.values().next().cloned()
    };
    let Some(session) = session else {
        return Ok(None);
    };
    let response = session
        .send_request("account/rateLimits/read", json!({}))
        .await?;
    let result = response.get("result").cloned().unwrap_or_default();
    Ok(parse_rate_limits_from_container(&result))
}

async fn refresh_usage_snapshot(app: &AppHandle) -> Result<UsageSnapshot, String> {
    let state = app.state::<AppState>();
    let now = now_ms();
    let cutoff = cutoff_ms(now);
    let mut rate_limits = match fetch_rate_limits_from_any_session(&state).await {
        Ok(rate_limits) => rate_limits,
        Err(_) => None,
    };
    if rate_limits.is_none() {
        rate_limits = match probe_rate_limits_via_temp_app_server(app).await {
            Ok(rate_limits) => rate_limits,
            Err(_) => None,
        };
    }

    {
        let mut store = state.usage_store.lock().await;
        prune_points(&mut store.app_server_points, cutoff);
        if !store.app_server_points.is_empty() {
            let total = sum_points(&store.app_server_points);
            let snapshot = UsageSnapshot {
                total_tokens_24h: Some(total),
                updated_at_ms: Some(now),
                source: UsageSource::AppServer,
                rate_limits: rate_limits.clone().or_else(|| store.last_rate_limits.clone()),
            };
            store.last_snapshot = Some(snapshot.clone());
            if rate_limits.is_some() {
                store.last_rate_limits = rate_limits.clone();
            }
            write_usage_store(&state.usage_path, &store)?;
            drop(store);
            emit_usage_snapshot(app, snapshot.clone()).await;
            return Ok(snapshot);
        }
    }

    let codex_home = resolve_codex_home();
    let scan_result = if let Some(home) = codex_home {
        let cutoff_copy = cutoff;
        tokio::task::spawn_blocking(move || scan_session_tokens_24h(&home, cutoff_copy))
            .await
            .map_err(|e| e.to_string())?
    } else {
        Ok(None)
    };

    let total_tokens = match scan_result {
        Ok(value) => value,
        Err(_) => {
            let store = state.usage_store.lock().await;
            return Ok(store
                .last_snapshot
                .clone()
                .unwrap_or_else(empty_usage_snapshot));
        }
    };

    let mut store = state.usage_store.lock().await;
    prune_points(&mut store.app_server_points, cutoff);
    if !store.app_server_points.is_empty() {
        let total = sum_points(&store.app_server_points);
        let snapshot = UsageSnapshot {
            total_tokens_24h: Some(total),
            updated_at_ms: Some(now),
            source: UsageSource::AppServer,
            rate_limits: rate_limits.clone().or_else(|| store.last_rate_limits.clone()),
        };
        store.last_snapshot = Some(snapshot.clone());
        if rate_limits.is_some() {
            store.last_rate_limits = rate_limits.clone();
        }
        write_usage_store(&state.usage_path, &store)?;
        drop(store);
        emit_usage_snapshot(app, snapshot.clone()).await;
        return Ok(snapshot);
    }

    let snapshot = match total_tokens {
        Some(total) => UsageSnapshot {
            total_tokens_24h: Some(total),
            updated_at_ms: Some(now),
            source: UsageSource::Sessions,
            rate_limits: rate_limits.clone().or_else(|| store.last_rate_limits.clone()),
        },
        None => UsageSnapshot {
            rate_limits: rate_limits.clone().or_else(|| store.last_rate_limits.clone()),
            ..empty_usage_snapshot()
        },
    };
    store.last_snapshot = Some(snapshot.clone());
    if rate_limits.is_some() {
        store.last_rate_limits = rate_limits.clone();
    }
    write_usage_store(&state.usage_path, &store)?;
    drop(store);
    emit_usage_snapshot(app, snapshot.clone()).await;
    Ok(snapshot)
}

async fn restart_usage_polling(app: &AppHandle) {
    let state = app.state::<AppState>();
    if let Some(handle) = state.usage_poll_handle.lock().await.take() {
        handle.abort();
    }

    let settings = state.settings.lock().await.clone();
    if !settings.usage_polling_enabled {
        return;
    }

    let interval_minutes = settings.usage_polling_interval_minutes.max(1).min(120);
    let interval_duration = Duration::from_secs(interval_minutes as u64 * 60);
    let app_handle = app.clone();
    let handle = tokio::spawn(async move {
        let _ = refresh_usage_snapshot(&app_handle).await;
        let mut ticker = tokio::time::interval(interval_duration);
        loop {
            ticker.tick().await;
            let _ = refresh_usage_snapshot(&app_handle).await;
        }
    });

    *state.usage_poll_handle.lock().await = Some(handle);
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
    let settings = {
        let state = app_handle.state::<AppState>();
        let settings = state.settings.lock().await.clone();
        settings
    };
    let codex_bin = entry
        .codex_bin
        .clone()
        .or_else(|| settings.codex_bin_path.clone())
        .unwrap_or_else(|| "codex".into());
    let codex_path = resolve_binary_path(&codex_bin);
    let requires_node = read_first_line(&codex_path)
        .ok()
        .flatten()
        .map(|line| shebang_requires_node(&line))
        .unwrap_or(false);
    let mut node_bin = settings.node_bin_path.clone();
    if requires_node && node_bin.is_none() {
        if let Some(suggested) = suggest_node_path(&codex_path) {
            node_bin = Some(suggested.to_string_lossy().to_string());
        }
    }
    let mut command = if requires_node {
        if let Some(node_path) = node_bin {
            let mut cmd = Command::new(node_path);
            cmd.arg(codex_path.to_string_lossy().to_string());
            cmd
        } else {
            Command::new(codex_path.to_string_lossy().to_string())
        }
    } else {
        Command::new(codex_path.to_string_lossy().to_string())
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
            let method_name = value
                .get("method")
                .and_then(|method| method.as_str())
                .unwrap_or("");

            if method_name == "thread/tokenUsage/updated" {
                if let Some(tokens) = extract_app_server_token_delta(&value) {
                    let _ = record_app_server_usage(&app_handle_clone, tokens).await;
                }
            }
            if method_name == "account/rateLimits/updated" {
                if let Some(params) = value.get("params") {
                    if let Some(rate_limits) = parse_rate_limits_from_container(params) {
                        let _ = record_rate_limits(&app_handle_clone, rate_limits).await;
                    }
                }
            }
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
            "name": "codexola",
            "title": "Codexola",
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
async fn search_files(
    workspace_id: String,
    query: String,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let trimmed = query.trim().to_lowercase();
    if trimmed.len() < 1 {
        return Ok(Vec::new());
    }
    let workspaces = state.workspaces.lock().await;
    let entry = workspaces
        .get(&workspace_id)
        .ok_or("workspace not found")?
        .clone();
    drop(workspaces);

    let root = PathBuf::from(entry.path);
    let limit = limit.unwrap_or(200);
    let max_scan = limit.saturating_mul(5).max(limit).max(200);
    let results = tokio::task::spawn_blocking(move || {
        let mut matches: Vec<String> = Vec::new();
        let walker = WalkBuilder::new(&root)
            .filter_entry(|entry| {
                if entry.depth() == 0 {
                    return true;
                }
                if entry
                    .file_type()
                    .map(|file_type| file_type.is_dir())
                    .unwrap_or(false)
                    && is_excluded_dir(entry.path())
                {
                    return false;
                }
                true
            })
            .build();

        for entry in walker {
            let entry = match entry {
                Ok(value) => value,
                Err(_) => continue,
            };
            if !entry
                .file_type()
                .map(|file_type| file_type.is_file())
                .unwrap_or(false)
            {
                continue;
            }
            let relative = match entry.path().strip_prefix(&root) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let relative_string = normalize_path(relative);
            let lower = relative_string.to_lowercase();
            if !lower.contains(&trimmed) {
                continue;
            }
            matches.push(relative_string);
            if matches.len() >= max_scan {
                break;
            }
        }

        matches.sort_by(|a, b| {
            let a_lower = a.to_lowercase();
            let b_lower = b.to_lowercase();
            let a_starts = a_lower.starts_with(&trimmed);
            let b_starts = b_lower.starts_with(&trimmed);
            if a_starts && !b_starts {
                return std::cmp::Ordering::Less;
            }
            if !a_starts && b_starts {
                return std::cmp::Ordering::Greater;
            }
            a_lower.cmp(&b_lower)
        });
        matches.truncate(limit);
        Ok::<Vec<String>, String>(matches)
    })
    .await
    .map_err(|_| "search failed".to_string())??;

    Ok(results)
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexBinInspection {
    requires_node: bool,
    suggested_node_path: Option<String>,
    resolved_path: String,
}

fn is_executable_path(path: &Path) -> bool {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return false,
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return false;
        }
    }
    true
}

fn read_first_line(path: &Path) -> Result<Option<String>, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut reader = StdBufReader::new(file);
    let mut line = String::new();
    let bytes = reader.read_line(&mut line).map_err(|e| e.to_string())?;
    if bytes == 0 {
        return Ok(None);
    }
    Ok(Some(line.trim_end_matches(&['\r', '\n'][..]).to_string()))
}

fn shebang_requires_node(line: &str) -> bool {
    if !line.starts_with("#!") {
        return false;
    }
    let shebang = line.trim_start_matches("#!").trim().to_lowercase();
    shebang.contains("node")
}

fn resolve_binary_path(raw: &str) -> PathBuf {
    fs::canonicalize(raw).unwrap_or_else(|_| PathBuf::from(raw))
}

fn suggest_node_path(codex_path: &Path) -> Option<PathBuf> {
    let parent = codex_path.parent()?;
    let candidate = parent.join("node");
    if is_executable_path(&candidate) {
        return Some(candidate);
    }
    None
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
    restart_usage_polling(&app).await;
    Ok(settings)
}

#[tauri::command]
async fn inspect_codex_bin(path: String) -> Result<CodexBinInspection, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Codex binary path is required.".to_string());
    }
    let sanitized = trimmed.trim_matches('"').trim_matches('\'');
    let resolved_path = resolve_binary_path(sanitized);
    let requires_node = match read_first_line(&resolved_path) {
        Ok(Some(line)) => shebang_requires_node(&line),
        _ => false,
    };
    let suggested_node_path = if requires_node {
        suggest_node_path(&resolved_path)
            .map(|path| path.to_string_lossy().to_string())
    } else {
        None
    };
    Ok(CodexBinInspection {
        requires_node,
        suggested_node_path,
        resolved_path: resolved_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
async fn validate_codex_bin(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Codex binary path is required.".to_string());
    }
    let sanitized = trimmed.trim_matches('"').trim_matches('\'');
    let metadata =
        fs::metadata(sanitized).map_err(|e| format!("Binary not found: {}", e))?;
    if !metadata.is_file() {
        return Err("Binary path must point to a file.".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = metadata.permissions().mode();
        if mode & 0o111 == 0 {
            return Err("Binary is not executable.".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
async fn usage_get_snapshot(state: State<'_, AppState>) -> Result<UsageSnapshot, String> {
    let store = state.usage_store.lock().await;
    Ok(store
        .last_snapshot
        .clone()
        .unwrap_or_else(empty_usage_snapshot))
}

#[tauri::command]
async fn usage_refresh(app: AppHandle) -> Result<UsageSnapshot, String> {
    refresh_usage_snapshot(&app).await
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
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                restart_usage_polling(&app_handle).await;
            });
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
            search_files,
            get_settings,
            update_settings,
            inspect_codex_bin,
            validate_codex_bin,
            usage_get_snapshot,
            usage_refresh,
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
