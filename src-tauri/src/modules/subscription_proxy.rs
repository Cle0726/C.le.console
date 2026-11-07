//! Workbench-only outbound proxy fed by a Clash/mihomo subscription.
//!
//! The subscription document is the same YAML or base64 node list used by
//! MetaCubeX/mihomo. HTTP and SOCKS5 nodes are dialed by the built-in local
//! proxy. Other protocols are handed to a local `mihomo` binary when one is
//! installed, because those tunnels are not reimplemented here.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::Engine;
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
    pub local_proxy: String,
    pub last_error: String,
    pub node_count: usize,
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
    std::fs::write(path, raw).map_err(|error| format!("保存订阅配置失败: {error}"))
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

pub fn enabled_local_proxy() -> Option<String> {
    let store = load_store().ok()?;
    if !store.enabled || store.selected_id.is_empty() {
        return None;
    }
    Some(active_local_proxy(&store))
}

pub fn get_state() -> Result<SubscriptionProxyState, String> {
    Ok(view(&load_store()?))
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
    let mut nodes = parse_subscription(&body);
    if nodes.is_empty() {
        return Err("订阅里没有识别到节点。支持 Clash/mihomo YAML，以及 base64 编码的节点链接。".into());
    }
    nodes.sort_by(|left, right| left.name.cmp(&right.name));
    let mut store = load_store()?;
    if !store.selected_id.is_empty() && !nodes.iter().any(|node| node.id == store.selected_id) {
        store.selected_id.clear();
        store.enabled = false;
    }
    store.url = url;
    store.nodes = nodes;
    store.last_error.clear();
    save_store(&store)?;
    Ok(view(&store))
}

pub async fn apply(node_id: String, enabled: bool) -> Result<SubscriptionProxyState, String> {
    let mut store = load_store()?;
    if !enabled {
        stop_engines();
        store.enabled = false;
        store.selected_id.clear();
        store.last_error.clear();
        save_store(&store)?;
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
    if let Err(error) = start_node(&node) {
        store.last_error = error.clone();
        save_store(&store)?;
        return Err(error);
    }
    store.selected_id = node.id;
    store.enabled = true;
    store.last_error.clear();
    save_store(&store)?;
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
    } else {
        remote
            .write_all(&buffer)
            .map_err(|error| error.to_string())?;
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
    let proxy = TcpStream::connect_timeout(
        &format!("{}:{}", upstream.server, upstream.port)
            .parse()
            .map_err(|error| format!("节点地址无效: {error}"))?,
        Duration::from_secs(15),
    )
    .map_err(|error| format!("连接节点失败: {error}"))?;
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
    let directory = get_data_dir()?.join("subscription-mihomo");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let config = serde_json::json!({
        "mixed-port": MIHOMO_PORT,
        "allow-lan": false,
        "bind-address": "127.0.0.1",
        "mode": "rule",
        "log-level": "warning",
        "ipv6": false,
        "proxies": [node.raw.clone()],
        "rules": [format!("MATCH,{}", node.name)],
    });
    let yaml = serde_yaml::to_string(&config).map_err(|error| format!("生成 mihomo 配置失败: {error}"))?;
    std::fs::write(directory.join("config.yaml"), yaml).map_err(|error| error.to_string())?;
    let child = Command::new(binary)
        .arg("-d")
        .arg(&directory)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("启动 mihomo 失败: {error}"))?;
    let mut runtime = runtime().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    runtime.mihomo = Some(child);
    runtime.route = None;
    Ok(())
}

fn find_mihomo() -> Option<PathBuf> {
    let mut candidates = Vec::new();
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

async fn fetch_subscription(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::limited(5))
        .no_proxy()
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(url)
        .header("user-agent", "clash.meta")
        .send()
        .await
        .map_err(|error| format!("拉取订阅失败: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("订阅服务器返回 HTTP {}", response.status()));
    }
    response
        .text()
        .await
        .map_err(|error| format!("读取订阅内容失败: {error}"))
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
    let usable = matches!(kind.as_str(), "http" | "socks5" | "socks");
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
            let kind = if kind == "https" { "http" } else { kind.as_str() };
            let raw = serde_json::json!({
                "name": display,
                "type": kind,
                "server": server,
                "port": port,
                "username": username,
                "password": password,
            });
            Some(stored_node(
                display,
                if kind == "socks" { "socks5".into() } else { kind.into() },
                server,
                port,
                username,
                password,
                true,
                raw,
            ))
        }
        "vmess" => parse_vmess(line),
        "trojan" | "vless" | "ss" | "hysteria" | "hysteria2" | "hy2" => {
            let server = url.host_str().unwrap_or_default().to_string();
            let port = url.port().unwrap_or(0);
            let display = if name.is_empty() {
                format!("{kind} {server}:{port}")
            } else {
                name
            };
            let raw = serde_json::json!({
                "name": display,
                "type": kind,
                "server": server,
                "port": port,
            });
            Some(stored_node(display, kind, server, port, String::new(), String::new(), false, raw))
        }
        _ => None,
    }
}

fn parse_vmess(line: &str) -> Option<StoredNode> {
    let payload = line.trim_start_matches("vmess://");
    let decoded = decode_base64_document(payload)?;
    let value: Value = serde_json::from_str(&decoded).ok()?;
    let name = value.get("ps").and_then(Value::as_str).unwrap_or("vmess").to_string();
    let server = value.get("add").and_then(Value::as_str).unwrap_or_default().to_string();
    let port = value
        .get("port")
        .and_then(|item| item.as_u64().or_else(|| item.as_str().and_then(|text| text.parse().ok())))
        .and_then(|port| u16::try_from(port).ok())
        .unwrap_or(0);
    let mut raw = value;
    if let Some(object) = raw.as_object_mut() {
        object.insert("name".into(), Value::String(name.clone()));
        object.insert("type".into(), Value::String("vmess".into()));
        object.insert("server".into(), Value::String(server.clone()));
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
    let compact: String = value.chars().filter(|char| !char.is_whitespace()).collect();
    if compact.len() < 8 {
        return None;
    }
    for engine in [
        base64::engine::general_purpose::STANDARD,
        base64::engine::general_purpose::URL_SAFE,
    ] {
        if let Ok(bytes) = base64::Engine::decode(&engine, &compact) {
            if let Ok(text) = String::from_utf8(bytes) {
                if text.contains("://") || text.contains("proxies:") {
                    return Some(text);
                }
            }
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
pub async fn subscription_proxy_apply(
    node_id: String,
    enabled: bool,
) -> Result<SubscriptionProxyState, String> {
    apply(node_id, enabled).await
}

#[cfg(test)]
mod tests {
    use super::parse_subscription;

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
}
