//! Workbench-only outbound proxy fed by a Clash/mihomo subscription.
//!
//! The subscription document is the same YAML or base64 node list used by
//! MetaCubeX/mihomo. HTTP and SOCKS5 nodes are dialed by the built-in local
//! proxy. Other protocols are handed to a local `mihomo` binary when one is
//! installed, because those tunnels are not reimplemented here.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::Engine;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::Url;

use crate::modules::config::get_data_dir;
use crate::modules::logger;

const BUILTIN_PORT: u16 = 17890;
const MIHOMO_PORT: u16 = 17891;
const STORE_FILE: &str = "subscription_proxy.json";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionNodeView {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub server: String,
    pub port: u16,
    pub usable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionProxyState {
    pub url: String,
    pub nodes: Vec<SubscriptionNodeView>,
    pub selected_id: String,
    pub enabled: bool,
    pub ready: bool,
    pub local_proxy: String,
    pub last_error: String,
    pub node_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionConnectivity {
    pub provider: String,
    pub reachable: bool,
    pub status: Option<u16>,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredNode {
    id: String,
    name: String,
    kind: String,
    server: String,
    port: u16,
    username: String,
    password: String,
    usable: bool,
    raw: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Store {
    url: String,
    nodes: Vec<StoredNode>,
    selected_id: String,
    enabled: bool,
    #[serde(default)]
    last_error: String,
}

#[derive(Clone)]
struct Upstream {
    kind: String,
    server: String,
    port: u16,
    username: String,
    password: String,
}

struct Runtime {
    route: Option<Upstream>,
    mihomo: Option<Child>,
}

fn runtime() -> &'static Mutex<Runtime> {
    static RUNTIME: OnceLock<Mutex<Runtime>> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        Mutex::new(Runtime {
            route: None,
            mihomo: None,
        })
    })
}

fn store_path() -> Result<PathBuf, String> {
    Ok(get_data_dir()?.join(STORE_FILE))
}

fn load_store() -> Result<Store, String> {
    let path = store_path()?;
    if !path.exists() {
        return Ok(Store::default());
    }
    let raw = std::fs::read_to_string(&path).map_err(|error| format!("读取订阅配置失败: {error}"))?;
    serde_json::from_str(&raw).map_err(|error| format!("订阅配置损坏: {error}"))
}

fn save_store(store: &Store) -> Result<(), String> {
    let path = store_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("创建订阅目录失败: {error}"))?;
    }
    let raw = serde_json::to_string_pretty(store).map_err(|error| error.to_string())?;
    crate::modules::atomic_write::write_private_string_atomic(&path, &raw)
        .map_err(|error| format!("保存订阅配置失败: {error}"))
}

fn view(store: &Store) -> SubscriptionProxyState {
    SubscriptionProxyState {
        url: store.url.clone(),
        nodes: store
            .nodes
            .iter()
            .map(|node| SubscriptionNodeView {
                id: node.id.clone(),
                name: node.name.clone(),
                kind: node.kind.clone(),
                server: node.server.clone(),
                port: node.port,
                usable: node.usable,
            })
            .collect(),
        selected_id: store.selected_id.clone(),
        enabled: store.enabled,
        ready: store.enabled && runtime_is_ready(store),
        local_proxy: if store.enabled {
            active_local_proxy(store)
        } else {
            String::new()
        },
        last_error: store.last_error.clone(),
        node_count: store.nodes.len(),
    }
}

fn active_local_proxy(store: &Store) -> String {
    let builtin = store
        .nodes
        .iter()
        .find(|node| node.id == store.selected_id)
        .map(|node| node.usable)
        .unwrap_or(false);
    format!(
        "http://127.0.0.1:{}",
        if builtin { BUILTIN_PORT } else { MIHOMO_PORT }
    )
}

fn runtime_is_ready(store: &Store) -> bool {
    let builtin = store.nodes.iter().find(|node| node.id == store.selected_id).map(|node| node.usable);
    let mut runtime = runtime().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match builtin {
        Some(true) => runtime.route.is_some(),
        Some(false) => match runtime.mihomo.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        },
        None => false,
    }
}

pub fn enabled_local_proxy() -> Option<String> {
    let store = load_store().ok()?;
    if !store.enabled || store.selected_id.is_empty() {
        return None;
    }
    // Port 0 cannot accept a TCP connection. Do not accidentally send account
    // traffic to another program occupying our expected port after a failure.
    Some(if runtime_is_ready(&store) { active_local_proxy(&store) } else { "http://127.0.0.1:0".to_string() })
}

pub fn get_state() -> Result<SubscriptionProxyState, String> {
    Ok(view(&load_store()?))
}

/// Restore the actual proxy engine before any managed HTTP clients start.
/// Keep the selected route enabled on failure: silently falling back to a
/// direct connection would disclose requests outside the requested route.
pub fn restore_on_startup() -> Result<(), String> {
    let mut store = load_store()?;
    if !store.enabled {
        return Ok(());
    }
    let node = match store.nodes.iter().find(|node| node.id == store.selected_id).cloned() {
        Some(node) => node,
        None => {
            let error = "已启用的订阅节点不存在，请重新选择节点".to_string();
            store.last_error = error.clone();
            let _ = save_store(&store);
            return Err(error);
        }
    };
    if let Err(error) = start_node(&node) {
        store.last_error = error.clone();
        let _ = save_store(&store);
        return Err(error);
    }
    store.last_error.clear();
    save_store(&store)
}

fn update_document(mut store: Store, body: &str, url: Option<String>) -> Result<Store, String> {
    let mut nodes = parse_subscription(body);
    if nodes.is_empty() {
        return Err("没有识别到节点。请粘贴 Clash/mihomo YAML、节点链接或其 base64 内容。".into());
    }
    nodes.sort_by(|left, right| left.name.cmp(&right.name));
    if !store.selected_id.is_empty() && !nodes.iter().any(|node| node.id == store.selected_id) {
        // Do not silently switch the active network route while importing.
        return Err("新订阅不包含正在使用的节点，请先关闭当前订阅后再导入。".into());
    }
    if store.enabled {
        let previous = store.nodes.iter().find(|node| node.id == store.selected_id);
        let updated = nodes.iter().find(|node| node.id == store.selected_id);
        if let (Some(previous), Some(updated)) = (previous, updated) {
            if previous.raw != updated.raw {
                // The running engine still uses the previous credentials/options.
                // Do not save a document that misrepresents its live route.
                return Err("当前节点配置已变化，请先关闭订阅后再更新并重新选择节点。".into());
            }
        }
    }
    if let Some(url) = url { store.url = url; }
    store.nodes = nodes;
    store.last_error.clear();
    Ok(store)
}

pub async fn refresh(url: String) -> Result<SubscriptionProxyState, String> {
    let url = url.trim().to_string();
    if Url::parse(&url)
        .ok()
        .filter(|item| item.scheme() == "http" || item.scheme() == "https")
        .is_none()
    {
        return Err("订阅地址必须是 http 或 https".into());
    }
    let body = fetch_subscription(&url).await?;
    let store = update_document(load_store()?, &body, Some(url))?;
    save_store(&store)?;
    Ok(view(&store))
}

pub fn import_content(content: String) -> Result<SubscriptionProxyState, String> {
    if content.len() > 8 * 1024 * 1024 {
        return Err("订阅内容超过 8 MB，请检查粘贴的内容。".into());
    }
    let store = update_document(load_store()?, &content, None)?;
    save_store(&store)?;
    Ok(view(&store))
}

fn sync_application_proxy() {
    let config = crate::modules::config::get_user_config();
    crate::modules::config::sync_global_proxy_env(&config);
    crate::modules::codex_local_access::trigger_gateway_reload_in_background("订阅代理变更");
}

pub async fn apply(node_id: String, enabled: bool) -> Result<SubscriptionProxyState, String> {
    let mut store = load_store()?;
    if !enabled {
        stop_engines();
        store.enabled = false;
        store.selected_id.clear();
        store.last_error.clear();
        save_store(&store)?;
        sync_application_proxy();
        if let Err(error) = crate::modules::multi_model_api::reload_runtime_config().await {
            store.last_error = error.clone();
            save_store(&store)?;
            return Err(error);
        }
        return Ok(view(&store));
    }

    let node = store
        .nodes
        .iter()
        .find(|item| item.id == node_id)
        .cloned()
        .ok_or_else(|| "请先选择一个订阅节点".to_string())?;
    let previous = store.nodes.iter().find(|item| store.enabled && item.id == store.selected_id).cloned();
    if let Err(error) = start_node(&node) {
        if let Some(previous) = previous { let _ = start_node(&previous); }
        store.last_error = error.clone();
        save_store(&store)?;
        return Err(error);
    }
    store.selected_id = node.id;
    store.enabled = true;
    store.last_error.clear();
    save_store(&store)?;
    sync_application_proxy();
    if let Err(error) = crate::modules::multi_model_api::reload_runtime_config().await {
        store.last_error = error.clone();
        save_store(&store)?;
        return Err(error);
    }
    Ok(view(&load_store()?))
}

fn start_node(node: &StoredNode) -> Result<(), String> {
    if node.usable {
        stop_mihomo();
        ensure_builtin()?;
        let mut runtime = runtime().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        runtime.route = Some(Upstream {
            kind: node.kind.clone(),
            server: node.server.clone(),
            port: node.port,
            username: node.username.clone(),
            password: node.password.clone(),
        });
        return Ok(());
    }
    start_mihomo(node)
}

fn ensure_builtin() -> Result<(), String> {
    static STARTED: Mutex<bool> = Mutex::new(false);
    let mut started = STARTED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if *started {
        return Ok(());
    }
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], BUILTIN_PORT)))
        .map_err(|error| format!("本地订阅代理端口 {BUILTIN_PORT} 无法监听: {error}"))?;
    listener
        .set_nonblocking(false)
        .map_err(|error| error.to_string())?;
    std::thread::Builder::new()
        .name("subscription-proxy".into())
        .spawn(move || accept_loop(listener))
        .map_err(|error| format!("启动订阅代理失败: {error}"))?;
    *started = true;
    Ok(())
}

fn accept_loop(listener: TcpListener) {
    for stream in listener.incoming().flatten() {
        std::thread::spawn(move || {
            if let Err(error) = handle_client(stream) {
                logger::log_warn(&format!("[SubscriptionProxy] {error}"));
            }
        });
    }
}

fn handle_client(mut client: TcpStream) -> Result<(), String> {
    client
        .set_read_timeout(Some(Duration::from_secs(20)))
        .map_err(|error| error.to_string())?;
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    let header_end = loop {
        let read = client.read(&mut chunk).map_err(|error| error.to_string())?;
        if read == 0 {
            return Ok(());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(position) = buffer.windows(4).position(|item| item == b"\r\n\r\n") {
            break position + 4;
        }
        if buffer.len() > 64 * 1024 {
            return Err("代理请求头过大".into());
        }
    };
    let header = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let request = header.lines().next().unwrap_or_default();
    let mut parts = request.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();
    let (host, port) = if method.eq_ignore_ascii_case("CONNECT") {
        split_host_port(target, 443)?
    } else {
        let url = Url::parse(target).map_err(|_| "只支持 CONNECT 或绝对 URL 代理请求".to_string())?;
        let host = url.host_str().unwrap_or_default().to_string();
        let port = url.port_or_known_default().unwrap_or(80);
        (host, port)
    };
    let upstream = {
        let runtime = runtime().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        runtime
            .route
            .clone()
            .ok_or_else(|| "还没有选择订阅节点".to_string())?
    };
    let mut remote = dial_upstream(&upstream, &host, port)?;
    if method.eq_ignore_ascii_case("CONNECT") {
        client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .map_err(|error| error.to_string())?;
        // TLS bytes may arrive in the same read as CONNECT headers.
        if buffer.len() > header_end {
            remote.write_all(&buffer[header_end..]).map_err(|error| error.to_string())?;
        }
    } else {
        // We already established a CONNECT tunnel to the origin; origin servers
        // expect origin-form, not the absolute proxy-form request target.
        let url = Url::parse(target).map_err(|_| "代理请求地址无效".to_string())?;
        let mut path = url.path().to_string();
        if let Some(query) = url.query() { path.push('?'); path.push_str(query); }
        let version = parts.next().unwrap_or("HTTP/1.1");
        let mut forwarded = format!("{method} {path} {version}\r\n").into_bytes();
        for line in header.lines().skip(1) {
            if line.is_empty() || line.to_ascii_lowercase().starts_with("proxy-authorization:")
                || line.to_ascii_lowercase().starts_with("proxy-connection:") { continue; }
            forwarded.extend_from_slice(line.as_bytes());
            forwarded.extend_from_slice(b"\r\n");
        }
        forwarded.extend_from_slice(b"\r\n");
        forwarded.extend_from_slice(&buffer[header_end..]);
        remote.write_all(&forwarded).map_err(|error| error.to_string())?;
    }
    client
        .set_read_timeout(None)
        .map_err(|error| error.to_string())?;
    remote
        .set_read_timeout(None)
        .map_err(|error| error.to_string())?;
    let mut outbound = client.try_clone().map_err(|error| error.to_string())?;
    let mut inbound = remote.try_clone().map_err(|error| error.to_string())?;
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut client, &mut remote);
    });
    let _ = std::io::copy(&mut inbound, &mut outbound);
    Ok(())
}

fn split_host_port(value: &str, default_port: u16) -> Result<(String, u16), String> {
    if let Some((host, port)) = value.rsplit_once(':') {
        if !host.contains(']') || host.ends_with(']') {
            let port = port.parse::<u16>().map_err(|_| "端口无效".to_string())?;
            let host = host.trim_matches(['[', ']']).to_string();
            if host.is_empty() {
                return Err("目标主机为空".into());
            }
            return Ok((host, port));
        }
    }
    Ok((value.to_string(), default_port))
}

fn dial_upstream(upstream: &Upstream, host: &str, port: u16) -> Result<TcpStream, String> {
    let addresses = (upstream.server.as_str(), upstream.port).to_socket_addrs()
        .map_err(|error| format!("解析节点地址失败: {error}"))?;
    let mut proxy = None;
    for address in addresses {
        if let Ok(stream) = TcpStream::connect_timeout(&address, Duration::from_secs(5)) {
            proxy = Some(stream);
            break;
        }
    }
    let proxy = proxy.ok_or_else(|| "连接节点失败，请检查网络、节点地址和端口".to_string())?;
    proxy
        .set_read_timeout(Some(Duration::from_secs(20)))
        .map_err(|error| error.to_string())?;
    proxy
        .set_write_timeout(Some(Duration::from_secs(20)))
        .map_err(|error| error.to_string())?;
    let mut proxy = proxy;
    if upstream.kind == "socks5" || upstream.kind == "socks" {
        socks5_connect(&mut proxy, upstream, host, port)?;
    } else {
        http_connect(&mut proxy, upstream, host, port)?;
    }
    Ok(proxy)
}

fn socks5_connect(
    stream: &mut TcpStream,
    upstream: &Upstream,
    host: &str,
    port: u16,
) -> Result<(), String> {
    let auth = !upstream.username.is_empty();
    let greeting = if auth {
        [0x05, 0x01, 0x02]
    } else {
        [0x05, 0x01, 0x00]
    };
    stream
        .write_all(&greeting)
        .map_err(|error| error.to_string())?;
    let mut response = [0_u8; 2];
    stream
        .read_exact(&mut response)
        .map_err(|error| format!("SOCKS5 握手失败: {error}"))?;
    if response[1] == 0x02 {
        let user = upstream.username.as_bytes();
        let pass = upstream.password.as_bytes();
        if user.len() > 255 || pass.len() > 255 {
            return Err("SOCKS5 账号或密码超过 255 字节".into());
        }
        let mut packet = Vec::with_capacity(3 + user.len() + pass.len());
        packet.push(0x01);
        packet.push(user.len() as u8);
        packet.extend_from_slice(user);
        packet.push(pass.len() as u8);
        packet.extend_from_slice(pass);
        stream
            .write_all(&packet)
            .map_err(|error| error.to_string())?;
        let mut auth_response = [0_u8; 2];
        stream
            .read_exact(&mut auth_response)
            .map_err(|error| error.to_string())?;
        if auth_response[1] != 0 {
            return Err("SOCKS5 账号或密码被拒绝".into());
        }
    } else if response[1] != 0x00 {
        return Err("节点不接受 SOCKS5 无认证连接".into());
    }
    let host_bytes = host.as_bytes();
    if host_bytes.len() > 255 {
        return Err("目标主机名过长".into());
    }
    let mut request = vec![0x05, 0x01, 0x00, 0x03, host_bytes.len() as u8];
    request.extend_from_slice(host_bytes);
    request.extend_from_slice(&port.to_be_bytes());
    stream
        .write_all(&request)
        .map_err(|error| error.to_string())?;
    let mut head = [0_u8; 4];
    stream
        .read_exact(&mut head)
        .map_err(|error| format!("SOCKS5 连接失败: {error}"))?;
    if head[1] != 0 {
        return Err(format!("SOCKS5 节点拒绝连接，代码 {}", head[1]));
    }
    let skip = match head[3] {
        0x01 => 4,
        0x04 => 16,
        0x03 => {
            let mut length = [0_u8; 1];
            stream
                .read_exact(&mut length)
                .map_err(|error| error.to_string())?;
            length[0] as usize
        }
        _ => 0,
    };
    let mut discard = vec![0_u8; skip + 2];
    stream
        .read_exact(&mut discard)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn http_connect(
    stream: &mut TcpStream,
    upstream: &Upstream,
    host: &str,
    port: u16,
) -> Result<(), String> {
    let mut request = format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n");
    if !upstream.username.is_empty() || !upstream.password.is_empty() {
        let token = base64::engine::general_purpose::STANDARD
            .encode(format!("{}:{}", upstream.username, upstream.password));
        request.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;
    let mut response = Vec::new();
    let mut chunk = [0_u8; 1024];
    loop {
        let read = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        response.extend_from_slice(&chunk[..read]);
        if response.windows(4).any(|item| item == b"\r\n\r\n") {
            break;
        }
    }
    let text = String::from_utf8_lossy(&response);
    let status = text.split_whitespace().nth(1).unwrap_or("0");
    if status != "200" {
        return Err(format!("HTTP 节点拒绝 CONNECT，状态 {status}"));
    }
    Ok(())
}

fn start_mihomo(node: &StoredNode) -> Result<(), String> {
    let binary = find_mihomo().ok_or_else(|| {
        format!(
            "节点「{}」是 {} 协议。内置转发可以直接接通 HTTP / SOCKS5。其余协议沿用 mihomo 的订阅格式，请先安装 mihomo 或把可执行文件放到应用数据目录。",
            node.name, node.kind
        )
    })?;
    stop_mihomo();
    let available = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], MIHOMO_PORT)))
        .map_err(|_| format!("本地节点端口 {MIHOMO_PORT} 已被占用，请关闭占用该端口的程序"))?;
    drop(available);
    let directory = get_data_dir()?.join("subscription-mihomo");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let mut proxy_node = node.raw.clone();
    proxy_node["name"] = Value::String("C-LE-SELECTED".into());
    let config = serde_json::json!({
        "mixed-port": MIHOMO_PORT,
        "allow-lan": false,
        "bind-address": "127.0.0.1",
        "mode": "rule",
        "log-level": "warning",
        "ipv6": false,
        "proxies": [proxy_node],
        "rules": ["MATCH,C-LE-SELECTED"],
    });
    let yaml = serde_yaml::to_string(&config).map_err(|error| format!("生成 mihomo 配置失败: {error}"))?;
    crate::modules::atomic_write::write_private_string_atomic(&directory.join("config.yaml"), &yaml)?;
    let mut command = Command::new(binary);
    command.arg("-d")
        .arg(&directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn()
        .map_err(|error| format!("启动 mihomo 失败: {error}"))?;
    let deadline = std::time::Instant::now() + Duration::from_secs(6);
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return Err(format!("节点内核启动失败（{status}），请检查节点协议和配置"));
        }
        if TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], MIHOMO_PORT)), Duration::from_millis(150)).is_ok() { break; }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("节点内核启动超时，请检查节点配置".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let mut runtime = runtime().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    runtime.mihomo = Some(child);
    runtime.route = None;
    Ok(())
}

fn find_mihomo() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(if cfg!(windows) { "mihomo.exe" } else { "mihomo" }));
        }
    }
    if let Ok(dir) = get_data_dir() {
        candidates.push(dir.join("mihomo"));
        candidates.push(dir.join("mihomo.exe"));
    }
    if let Ok(path) = std::env::var("PATH") {
        for item in std::env::split_paths(&path) {
            candidates.push(item.join("mihomo"));
            candidates.push(item.join("mihomo.exe"));
        }
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn stop_mihomo() {
    let mut runtime = runtime().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(mut child) = runtime.mihomo.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn stop_engines() {
    stop_mihomo();
    let mut runtime = runtime().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    runtime.route = None;
}

pub fn shutdown_for_exit() {
    stop_engines();
}

async fn fetch_subscription(url: &str) -> Result<String, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::limited(5));
    if let Some(proxy) = enabled_local_proxy() {
        builder = builder.proxy(reqwest::Proxy::all(&proxy).map_err(|_| "订阅代理配置无效")?);
    }
    let client = builder
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(url)
        .header("user-agent", "clash.meta")
        .send()
        .await
        .map_err(|error| format!("拉取订阅失败: {}。请检查订阅地址是否可访问，或粘贴订阅内容。", error.without_url()))?;
    if !response.status().is_success() {
        return Err(format!("订阅服务器返回 HTTP {}", response.status()));
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("读取订阅内容失败: {}", error.without_url()))?;
        if body.len() + chunk.len() > 8 * 1024 * 1024 { return Err("订阅内容超过 8 MB".into()); }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).map_err(|_| "订阅内容不是有效 UTF-8".into())
}

fn parse_subscription(body: &str) -> Vec<StoredNode> {
    let trimmed = body.trim().trim_start_matches('\u{feff}');
    if let Some(nodes) = parse_clash_yaml(trimmed) {
        if !nodes.is_empty() {
            return nodes;
        }
    }
    let text = decode_base64_document(trimmed).unwrap_or_else(|| trimmed.to_string());
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(parse_share_link)
        .collect()
}

fn parse_clash_yaml(text: &str) -> Option<Vec<StoredNode>> {
    let value: serde_yaml::Value = serde_yaml::from_str(text).ok()?;
    let proxies = value.get("proxies")?.as_sequence()?;
    Some(proxies.iter().filter_map(node_from_clash).collect())
}

fn node_from_clash(value: &serde_yaml::Value) -> Option<StoredNode> {
    let name = value.get("name")?.as_str()?.trim().to_string();
    let kind = value.get("type")?.as_str()?.trim().to_ascii_lowercase();
    let server = value.get("server")?.as_str()?.trim().to_string();
    let port = yaml_port(value.get("port")?)?;
    if name.is_empty() || server.is_empty() || port == 0 {
        return None;
    }
    let username = yaml_string(value, &["username", "user"]);
    let password = yaml_string(value, &["password", "uuid"]);
    let tls = value.get("tls").and_then(serde_yaml::Value::as_bool).unwrap_or(false);
    let usable = matches!(kind.as_str(), "http" | "socks5" | "socks") && !tls;
    let raw = serde_json::to_value(value).ok()?;
    Some(stored_node(name, kind, server, port, username, password, usable, raw))
}

fn yaml_port(value: &serde_yaml::Value) -> Option<u16> {
    value
        .as_u64()
        .and_then(|port| u16::try_from(port).ok())
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
}

fn yaml_string(value: &serde_yaml::Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| value.get(key).and_then(|item| item.as_str()))
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn parse_share_link(line: &str) -> Option<StoredNode> {
    // SIP002 also permits encoding the complete method:password@host:port.
    if let Some(rest) = line.strip_prefix("ss://") {
        let (address, fragment) = rest.split_once('#').unwrap_or((rest, ""));
        if !address.contains('@') && !address.contains('?') {
            let decoded = String::from_utf8(decode_base64_bytes(address)?).ok()?;
            if decoded.contains('@') {
                return parse_share_link(&format!("ss://{decoded}#{fragment}"));
            }
        }
    }
    let url = Url::parse(line).ok()?;
    let kind = url.scheme().to_ascii_lowercase();
    let name = urlencoding::decode(url.fragment().unwrap_or_default())
        .unwrap_or_default()
        .to_string();
    match kind.as_str() {
        "http" | "https" | "socks5" | "socks" => {
            let server = url.host_str()?.to_string();
            let port = url.port_or_known_default()?;
            let username = urlencoding::decode(url.username()).ok()?.to_string();
            let password = url
                .password()
                .map(|value| urlencoding::decode(value).unwrap_or_default().to_string())
                .unwrap_or_default();
            let display = if name.is_empty() {
                format!("{server}:{port}")
            } else {
                name
            };
            let secure_proxy = kind == "https";
            let kind = if secure_proxy { "http" } else { kind.as_str() };
            let mut raw = serde_json::json!({
                "name": display,
                "type": kind,
                "server": server,
                "port": port,
                "username": username,
                "password": password,
            });
            if secure_proxy { raw["tls"] = Value::Bool(true); }
            Some(stored_node(
                display,
                if kind == "socks" { "socks5".into() } else { kind.into() },
                server,
                port,
                username,
                password,
                !secure_proxy,
                raw,
            ))
        }
        "vmess" => parse_vmess(line),
        "trojan" | "vless" | "ss" | "hysteria" | "hysteria2" | "hy2" => {
            let server = url.host_str()?.to_string();
            let port = url.port()?;
            if server.is_empty() || port == 0 { return None; }
            let display = if name.is_empty() {
                format!("{kind} {server}:{port}")
            } else {
                name
            };
            let normalized_kind = if kind == "hy2" { "hysteria2" } else { kind.as_str() };
            let mut raw = serde_json::json!({
                "name": display,
                "type": normalized_kind,
                "server": server,
                "port": port,
            });
            let user = urlencoding::decode(url.username()).ok()?.to_string();
            let password = url.password().map(|p| urlencoding::decode(p).ok().map(|v| v.to_string())).flatten();
            match normalized_kind {
                "ss" => {
                    let credential = if let Some(password) = password { format!("{user}:{password}") }
                        else { String::from_utf8(decode_base64_bytes(&user)?).ok()? };
                    let (cipher, password) = credential.split_once(':')?;
                    if cipher.is_empty() || password.is_empty() { return None; }
                    raw["cipher"] = Value::String(cipher.into());
                    raw["password"] = Value::String(password.into());
                }
                "vless" => { if user.is_empty() { return None; } raw["uuid"] = Value::String(user); }
                "trojan" | "hysteria2" | "hysteria" => {
                    if user.is_empty() { return None; }
                    raw[if normalized_kind == "hysteria" { "auth-str" } else { "password" }] = Value::String(user);
                }
                _ => return None,
            }
            let query: std::collections::HashMap<String, String> = url.query_pairs().map(|(k,v)| (k.into_owned(),v.into_owned())).collect();
            let security = query.get("security").map(String::as_str).unwrap_or("");
            if normalized_kind == "vless" && matches!(security, "tls" | "reality") { raw["tls"] = Value::Bool(true); }
            if let Some(sni) = query.get("sni").or_else(|| query.get("peer")) {
                raw[if normalized_kind == "vless" { "servername" } else { "sni" }] = Value::String(sni.clone());
            }
            if let Some(fp) = query.get("fp") { raw["client-fingerprint"] = Value::String(fp.clone()); }
            if let Some(flow) = query.get("flow") { raw["flow"] = Value::String(flow.clone()); }
            if query.get("allowInsecure").or_else(|| query.get("insecure")).is_some_and(|v| v == "1" || v == "true") { raw["skip-cert-verify"] = Value::Bool(true); }
            if let Some(alpn) = query.get("alpn") { raw["alpn"] = Value::Array(alpn.split(',').map(|v| Value::String(v.into())).collect()); }
            if let Some(obfs) = query.get("obfs") { raw["obfs"] = Value::String(obfs.clone()); }
            if let Some(pass) = query.get("obfs-password") { raw["obfs-password"] = Value::String(pass.clone()); }
            if security == "reality" {
                let key = query.get("pbk")?;
                raw["reality-opts"] = serde_json::json!({"public-key":key,"short-id":query.get("sid").cloned().unwrap_or_default()});
            }
            if let Some(network) = query.get("type").or_else(|| query.get("network")) {
                if network == "ws" {
                    raw["network"] = Value::String("ws".into());
                    raw["ws-opts"] = serde_json::json!({"path":query.get("path").map(String::as_str).unwrap_or("/"),"headers":{"Host":query.get("host").map(String::as_str).unwrap_or(&server)}});
                } else if network == "grpc" {
                    raw["network"] = Value::String("grpc".into());
                    raw["grpc-opts"] = serde_json::json!({"grpc-service-name":query.get("serviceName").cloned().unwrap_or_default()});
                } else if network != "tcp" { return None; }
            }
            Some(stored_node(display, normalized_kind.into(), server, port, String::new(), String::new(), false, raw))
        }
        _ => None,
    }
}

fn parse_vmess(line: &str) -> Option<StoredNode> {
    let payload = line.trim_start_matches("vmess://");
    let decoded = String::from_utf8(decode_base64_bytes(payload)?).ok()?;
    let value: Value = serde_json::from_str(&decoded).ok()?;
    let name = value.get("ps").and_then(Value::as_str).unwrap_or("vmess").to_string();
    let server = value.get("add").and_then(Value::as_str).unwrap_or_default().to_string();
    let port = value
        .get("port")
        .and_then(|item| item.as_u64().or_else(|| item.as_str().and_then(|text| text.parse().ok())))
        .and_then(|port| u16::try_from(port).ok())
        .unwrap_or(0);
    if server.is_empty() || port == 0 || value.get("id").and_then(Value::as_str).is_none_or(|id| id.is_empty()) {
        return None;
    }
    let mut raw = value;
    if let Some(object) = raw.as_object_mut() {
        object.insert("name".into(), Value::String(name.clone()));
        object.insert("type".into(), Value::String("vmess".into()));
        object.insert("server".into(), Value::String(server.clone()));
        object.insert("port".into(), Value::from(port));
        if let Some(id) = object.get("id").cloned() { object.insert("uuid".into(), id); }
        let alter_id = object.get("aid").and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).unwrap_or(0);
        object.insert("alterId".into(), Value::from(alter_id));
        object.insert("cipher".into(), Value::String("auto".into()));
        if object.get("tls").and_then(Value::as_str) == Some("tls") { object.insert("tls".into(), Value::Bool(true)); } else { object.remove("tls"); }
        let network = object.get("net").and_then(Value::as_str).unwrap_or("").to_string();
        if network == "ws" {
            let path = object.get("path").and_then(Value::as_str).unwrap_or("/").to_string();
            let host = object.get("host").and_then(Value::as_str).unwrap_or(&server).to_string();
            object.insert("network".into(), Value::String("ws".into()));
            object.insert("ws-opts".into(), serde_json::json!({"path":path,"headers":{"Host":host}}));
        } else if network == "grpc" {
            let service = object.get("path").and_then(Value::as_str).unwrap_or("").to_string();
            object.insert("network".into(), Value::String("grpc".into()));
            object.insert("grpc-opts".into(), serde_json::json!({"grpc-service-name":service}));
        } else if !network.is_empty() && network != "tcp" { return None; }
        if let Some(sni) = object.get("sni").and_then(Value::as_str).map(str::to_string) { object.insert("servername".into(), Value::String(sni)); }
    }
    Some(stored_node(name, "vmess".into(), server, port, String::new(), String::new(), false, raw))
}

fn stored_node(
    name: String,
    kind: String,
    server: String,
    port: u16,
    username: String,
    password: String,
    usable: bool,
    raw: Value,
) -> StoredNode {
    let id = hex_id(&format!("{kind}|{server}|{port}|{name}"));
    StoredNode {
        id,
        name,
        kind,
        server,
        port,
        username,
        password,
        usable,
        raw,
    }
}

fn hex_id(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

fn decode_base64_document(value: &str) -> Option<String> {
    let text = String::from_utf8(decode_base64_bytes(value)?).ok()?;
    if text.contains("://") || text.contains("proxies:") { Some(text) } else { None }
}

fn decode_base64_bytes(value: &str) -> Option<Vec<u8>> {
    let compact: String = value.chars().filter(|char| !char.is_whitespace()).collect();
    if compact.len() < 8 {
        return None;
    }
    for engine in [
        base64::engine::general_purpose::STANDARD,
        base64::engine::general_purpose::URL_SAFE,
        base64::engine::general_purpose::STANDARD_NO_PAD,
        base64::engine::general_purpose::URL_SAFE_NO_PAD,
    ] {
        if let Ok(bytes) = base64::Engine::decode(&engine, &compact) {
            return Some(bytes);
        }
    }
    None
}

#[tauri::command]
pub fn subscription_proxy_get() -> Result<SubscriptionProxyState, String> {
    get_state()
}

#[tauri::command]
pub async fn subscription_proxy_refresh(url: String) -> Result<SubscriptionProxyState, String> {
    refresh(url).await
}

#[tauri::command]
pub fn subscription_proxy_import(content: String) -> Result<SubscriptionProxyState, String> {
    import_content(content)
}

#[tauri::command]
pub async fn subscription_proxy_probe() -> Result<Vec<SubscriptionConnectivity>, String> {
    let proxy = enabled_local_proxy().ok_or_else(|| "请先选择并启用订阅节点".to_string())?;
    if proxy.ends_with(":0") { return Err("订阅节点未就绪，请重新选择节点".into()); }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::limited(3))
        .proxy(reqwest::Proxy::all(&proxy).map_err(|_| "订阅代理地址无效")?)
        .build().map_err(|error| format!("创建检测客户端失败: {error}"))?;
    let mut results = Vec::new();
    for (provider, url) in [("OpenAI", "https://auth.openai.com/"), ("Google", "https://accounts.google.com/")] {
        match client.get(url).send().await {
            Ok(response) => results.push(SubscriptionConnectivity { provider: provider.into(), reachable: true, status: Some(response.status().as_u16()), error: String::new() }),
            Err(error) => results.push(SubscriptionConnectivity { provider: provider.into(), reachable: false, status: None, error: error.without_url().to_string() }),
        }
    }
    Ok(results)
}

#[tauri::command]
pub async fn subscription_proxy_apply(
    node_id: String,
    enabled: bool,
) -> Result<SubscriptionProxyState, String> {
    apply(node_id, enabled).await
}

#[cfg(test)]
mod tests {
    use super::{dial_upstream, handle_client, parse_subscription, runtime, update_document, Store, Upstream};
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn parses_clash_yaml_and_marks_protocol_nodes() {
        let body = r#"
proxies:
  - name: hk-http
    type: http
    server: 10.0.0.8
    port: 8080
    username: user
    password: secret
  - {name: tokyo, type: vmess, server: example.com, port: 443, uuid: abc}
"#;
        let nodes = parse_subscription(body);
        assert_eq!(nodes.len(), 2);
        assert!(nodes.iter().any(|node| node.name == "hk-http" && node.usable));
        assert!(nodes.iter().any(|node| node.kind == "vmess" && !node.usable));
    }

    #[test]
    fn parses_base64_share_links() {
        let plain = "socks5://user:pass@203.0.113.8:1080#香港\nhttp://proxy.example:8080#备用\n";
        let encoded = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            plain.as_bytes(),
        );
        let nodes = parse_subscription(&encoded);
        assert_eq!(nodes.len(), 2);
        assert!(nodes.iter().all(|node| node.usable));
        assert!(nodes.iter().any(|node| node.name == "香港" && node.port == 1080));
    }

    #[test]
    fn rejects_refresh_that_would_misrepresent_the_active_node() {
        let initial = "http://user:old@node.example:8080#test";
        let changed = "http://user:new@node.example:8080#test";
        let nodes = parse_subscription(initial);
        let store = Store { selected_id: nodes[0].id.clone(), enabled: true, nodes, ..Store::default() };
        assert!(update_document(store.clone(), initial, None).is_ok());
        assert!(update_document(store, changed, None).is_err());
    }

    #[test]
    fn parses_vmess_without_padding_and_preserves_ws_tls_credentials() {
        let json = r#"{"ps":"test","add":"node.example","port":"443","id":"00000000-0000-4000-8000-000000000001","aid":"0","net":"ws","host":"edge.example","path":"/ws","tls":"tls","sni":"edge.example"}"#;
        let link = format!("vmess://{}", base64::Engine::encode(&base64::engine::general_purpose::STANDARD_NO_PAD, json));
        let nodes = parse_subscription(&link);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].raw["uuid"], "00000000-0000-4000-8000-000000000001");
        assert_eq!(nodes[0].raw["port"], 443);
        assert_eq!(nodes[0].raw["tls"], true);
        assert_eq!(nodes[0].raw["ws-opts"]["path"], "/ws");
    }

    #[test]
    fn parses_common_share_links_without_discarding_credentials() {
        let ss = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, "aes-128-gcm:secret");
        let body = format!("ss://{ss}@node.example:8388#ss\ntrojan://secret@node.example:443?sni=edge.example#t\nvless://00000000-0000-4000-8000-000000000001@node.example:443?security=tls&type=ws&path=%2Fws#v\nhy2://secret@node.example:443?sni=edge.example#h");
        let nodes = parse_subscription(&body);
        assert_eq!(nodes.len(), 4);
        assert_eq!(nodes[0].raw["cipher"], "aes-128-gcm");
        assert_eq!(nodes[0].raw["password"], "secret");
        assert_eq!(nodes[1].raw["password"], "secret");
        assert_eq!(nodes[2].raw["uuid"], "00000000-0000-4000-8000-000000000001");
        assert_eq!(nodes[2].raw["ws-opts"]["path"], "/ws");
        assert_eq!(nodes[3].raw["type"], "hysteria2");
    }

    #[test]
    fn resolves_hostname_for_builtin_http_node() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut data = [0u8; 1024];
            let len = stream.read(&mut data).unwrap();
            assert!(String::from_utf8_lossy(&data[..len]).starts_with("CONNECT example.com:443 HTTP/1.1"));
            stream.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").unwrap();
        });
        let upstream = Upstream { kind: "http".into(), server: "localhost".into(), port, username: String::new(), password: String::new() };
        assert!(dial_upstream(&upstream, "example.com", 443).is_ok());
        server.join().unwrap();
    }

    #[test]
    fn connect_forwards_payload_sent_with_headers() {
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let upstream_port = upstream.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            stream.set_read_timeout(Some(std::time::Duration::from_secs(3))).unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                let mut byte = [0u8; 1]; stream.read_exact(&mut byte).unwrap(); header.push(byte[0]);
            }
            stream.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").unwrap();
            let mut payload = [0u8; 4]; stream.read_exact(&mut payload).unwrap();
            assert_eq!(&payload, b"PING");
            stream.write_all(b"PONG").unwrap();
        });
        runtime().lock().unwrap().route = Some(Upstream { kind: "http".into(), server: "127.0.0.1".into(), port: upstream_port, username: String::new(), password: String::new() });
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let relay = std::thread::spawn(move || { let (stream, _) = listener.accept().unwrap(); handle_client(stream).unwrap(); });
        let mut client = std::net::TcpStream::connect(address).unwrap();
        client.set_read_timeout(Some(std::time::Duration::from_secs(3))).unwrap();
        client.write_all(b"CONNECT auth.example:443 HTTP/1.1\r\nHost: auth.example:443\r\n\r\nPING").unwrap();
        let mut response = Vec::new();
        while !response.ends_with(b"\r\n\r\n") { let mut byte = [0u8; 1]; client.read_exact(&mut byte).unwrap(); response.push(byte[0]); }
        let mut body = [0u8; 4]; client.read_exact(&mut body).unwrap();
        assert_eq!(&body, b"PONG");
        drop(client);
        server.join().unwrap(); relay.join().unwrap();
        runtime().lock().unwrap().route = None;
    }

    #[test]
    fn reqwest_reaches_an_unresolvable_origin_via_workbench_node() {
        let _guard = crate::modules::test_support::env_lock().lock().unwrap();
        let upstream = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let upstream_port = upstream.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") { let mut b = [0u8; 1]; stream.read_exact(&mut b).unwrap(); header.push(b[0]); }
            assert!(String::from_utf8_lossy(&header).starts_with("CONNECT unavailable.invalid:1234"));
            stream.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") { let mut b = [0u8; 1]; stream.read_exact(&mut b).unwrap(); request.push(b[0]); }
            assert!(String::from_utf8_lossy(&request).starts_with("GET /probe?x=1 HTTP/1.1"));
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK").unwrap();
        });
        runtime().lock().unwrap().route = Some(Upstream { kind: "http".into(), server: "localhost".into(), port: upstream_port, username: String::new(), password: String::new() });
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let relay = std::thread::spawn(move || { let (stream, _) = listener.accept().unwrap(); handle_client(stream).unwrap(); });
        let proxy_url = format!("http://{address}");
        let keys = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];
        let before: Vec<_> = keys.iter().map(|key| std::env::var_os(key)).collect();
        for key in ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] { std::env::set_var(key, &proxy_url); }
        for key in ["NO_PROXY", "no_proxy"] { std::env::set_var(key, "127.0.0.1,localhost,::1"); }
        let client = reqwest::blocking::Client::builder().timeout(std::time::Duration::from_secs(5)).build().unwrap();
        let response = client.get("http://unavailable.invalid:1234/probe?x=1").send().unwrap();
        assert_eq!(response.text().unwrap(), "OK");
        for (key, old) in keys.iter().zip(before) { if let Some(value) = old { std::env::set_var(key, value); } else { std::env::remove_var(key); } }
        server.join().unwrap(); relay.join().unwrap();
        runtime().lock().unwrap().route = None;
    }
}
