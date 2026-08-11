use serde::Serialize;
use std::{
    env,
    fs::{self, OpenOptions},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

const INFINITE_CANVAS_PORT: u16 = 3000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InfiniteCanvasRuntimeState {
    running: bool,
    port: u16,
    root_path: Option<String>,
    version: Option<String>,
    source: String,
}

fn port_is_listening() -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], INFINITE_CANVAS_PORT));
    TcpStream::connect_timeout(&address, Duration::from_millis(240)).is_ok()
}

fn runtime_is_ready() -> bool {
    let client = match reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_millis(320))
        .timeout(Duration::from_millis(650))
        .no_proxy()
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    let response = match client
        .get(format!(
            "http://127.0.0.1:{INFINITE_CANVAS_PORT}/api/app-info"
        ))
        .send()
    {
        Ok(response) if response.status().is_success() => response,
        _ => return false,
    };
    response
        .json::<serde_json::Value>()
        .ok()
        .and_then(|value| {
            value
                .get("repo_url")
                .and_then(serde_json::Value::as_str)
                .map(|url| url.contains("Infinite-Canvas"))
        })
        .unwrap_or(false)
}

fn is_runtime_root(path: &Path) -> bool {
    path.join("main.py").is_file() && path.join("static").join("canvas-list.html").is_file()
}

fn push_candidate(candidates: &mut Vec<PathBuf>, candidate: impl Into<PathBuf>) {
    let path = candidate.into();
    if !candidates.iter().any(|item| item == &path) {
        candidates.push(path);
    }
}

fn find_runtime_root() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = env::var_os("CLE_INFINITE_CANVAS_PATH") {
        push_candidate(&mut candidates, PathBuf::from(path));
    }
    push_candidate(&mut candidates, PathBuf::from(r"F:\Infinite-Canvas"));
    push_candidate(&mut candidates, PathBuf::from(r"C:\Infinite-Canvas"));
    if let Some(home) = dirs::home_dir() {
        push_candidate(&mut candidates, home.join("Infinite-Canvas"));
    }
    if let Ok(executable) = env::current_exe() {
        for parent in executable.ancestors().take(6) {
            push_candidate(&mut candidates, parent.join("Infinite-Canvas"));
        }
    }
    candidates.into_iter().find(|path| is_runtime_root(path))
}

fn runtime_version(root: Option<&Path>) -> Option<String> {
    root.and_then(|path| fs::read_to_string(path.join("VERSION")).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn state() -> InfiniteCanvasRuntimeState {
    let root = find_runtime_root();
    InfiniteCanvasRuntimeState {
        running: runtime_is_ready(),
        port: INFINITE_CANVAS_PORT,
        root_path: root.as_ref().map(|path| path.to_string_lossy().to_string()),
        version: runtime_version(root.as_deref()),
        source: "hero8152/Infinite-Canvas".to_string(),
    }
}

#[tauri::command]
pub fn infinite_canvas_get_state() -> InfiniteCanvasRuntimeState {
    state()
}

#[tauri::command]
pub async fn infinite_canvas_start() -> Result<InfiniteCanvasRuntimeState, String> {
    if runtime_is_ready() {
        return Ok(state());
    }
    if port_is_listening() {
        return Err(format!(
            "{} 端口已被其他程序占用，且该程序不是 Infinite Canvas。请释放端口后重试。",
            INFINITE_CANVAS_PORT
        ));
    }

    let root = find_runtime_root().ok_or_else(|| {
        "未找到 Infinite Canvas。请将源码放到 F:\\Infinite-Canvas，或设置 CLE_INFINITE_CANVAS_PATH。"
            .to_string()
    })?;

    let bundled_python = root.join("python").join("python.exe");
    let configured_python = env::var_os("CLE_INFINITE_CANVAS_PYTHON").map(PathBuf::from);
    let python = configured_python
        .filter(|path| path.is_file())
        .or_else(|| bundled_python.is_file().then_some(bundled_python))
        .unwrap_or_else(|| PathBuf::from("python"));

    let log_dir = root.join("data");
    fs::create_dir_all(&log_dir)
        .map_err(|error| format!("无法创建 Infinite Canvas 日志目录：{error}"))?;
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("cle-launch.stdout.log"))
        .map_err(|error| format!("无法打开 Infinite Canvas 启动日志：{error}"))?;
    let stderr = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("cle-launch.stderr.log"))
        .map_err(|error| format!("无法打开 Infinite Canvas 错误日志：{error}"))?;

    let mut command = Command::new(&python);
    command
        .arg("main.py")
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }

    command.spawn().map_err(|error| {
        format!(
            "启动 Infinite Canvas 失败（{}）：{error}",
            python.to_string_lossy()
        )
    })?;

    for _ in 0..40 {
        if runtime_is_ready() {
            return Ok(state());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    Err(format!(
        "Infinite Canvas 进程已启动，但 {} 端口在 8 秒内未就绪。请检查 {}。",
        INFINITE_CANVAS_PORT,
        log_dir.join("cle-launch.stderr.log").to_string_lossy()
    ))
}
