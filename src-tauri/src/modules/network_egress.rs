use chrono::Utc;
use reqwest::{Client, Proxy};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::io::{Read, Write};
use std::net::{IpAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
use url::Url;

const CONNECT_TIMEOUT: Duration = Duration::from_millis(650);
const CONTROLLER_TIMEOUT: Duration = Duration::from_secs(3);
const PUBLIC_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const PUBLIC_PROBE_CACHE_TTL: Duration = Duration::from_secs(45);
const MAX_CONTROLLER_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkEgressSnapshot {
    pub captured_at: String,
    pub platform: String,
    /// measured: controller returned at least one real connection; partial: proxy/controller
    /// configuration was detected; unknown: no authoritative evidence was available.
    pub observation_state: String,
    pub proxy: ProxyDetection,
    pub controller: ControllerDetection,
    pub public_probe: PublicEgressProbe,
    pub sources: Vec<EgressSourceSnapshot>,
    pub active_connections: Vec<EgressActiveConnection>,
    pub warnings: Vec<EgressWarning>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyDetection {
    pub selected_source: Option<String>,
    pub selected_endpoint: Option<String>,
    pub selected_pac_url: Option<String>,
    pub listener_reachable: Option<bool>,
    pub candidates: Vec<ProxyCandidate>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyCandidate {
    /// windows_internet_settings, winhttp, or environment.
    pub source: String,
    pub enabled: bool,
    pub endpoint: Option<String>,
    pub pac_url: Option<String>,
    pub bypass: Option<String>,
    pub listener_reachable: Option<bool>,
    pub evidence: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerDetection {
    /// connected, unavailable, or not_detected.
    pub status: String,
    pub transport: Option<String>,
    pub endpoint: Option<String>,
    pub implementation: Option<String>,
    pub version: Option<String>,
    pub config_path: Option<String>,
    pub active_connections: usize,
    pub download_total: u64,
    pub upload_total: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicEgressProbe {
    /// measured, failed, or not_run.
    pub state: String,
    pub public_ip: Option<String>,
    pub country_code: Option<String>,
    pub via_proxy: bool,
    pub proxy_source: Option<String>,
    /// This probe represents this backend process only. It must not be presented as a
    /// per-application ChatGPT/Claude measurement.
    pub scope: String,
    pub provider: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EgressSourceSnapshot {
    pub id: String,
    /// controller_observed or not_observed.
    pub observation_state: String,
    pub process_names: Vec<String>,
    pub routes: Vec<String>,
    pub nodes: Vec<String>,
    pub rules: Vec<String>,
    pub active_connections: usize,
    pub download_bytes: u64,
    pub upload_bytes: u64,
    /// The Clash connections API does not expose a public IP per connection. Keeping
    /// this null prevents a route name from being mistaken for a measured egress IP.
    pub public_ip: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EgressActiveConnection {
    pub id: String,
    pub source: String,
    pub process: Option<String>,
    pub process_id: Option<u32>,
    /// controller_metadata, windows_tcp_owner, or unresolved.
    pub process_source: String,
    pub source_port: Option<u16>,
    pub target: String,
    pub protocol: String,
    pub route: Option<String>,
    pub node: Option<String>,
    pub chains: Vec<String>,
    pub rule: Option<String>,
    pub download_bytes: u64,
    pub upload_bytes: u64,
    pub start: Option<String>,
    pub observation_state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EgressWarning {
    pub code: String,
    pub message: String,
}

#[derive(Debug)]
struct ProxyDetectionInternal {
    public: ProxyDetection,
    selected_endpoint: Option<String>,
    selected_is_pac_only: bool,
}

#[derive(Debug, Clone)]
enum ControllerTransport {
    Tcp,
    NamedPipe,
}

#[derive(Debug, Clone)]
struct ControllerTarget {
    transport: ControllerTransport,
    endpoint: String,
    secret: Option<String>,
    config_path: Option<PathBuf>,
}

#[derive(Debug)]
struct ControllerResult {
    public: ControllerDetection,
    connections: Vec<ControllerConnection>,
}

#[derive(Debug, Clone)]
struct CachedPublicProbe {
    cache_key: String,
    captured_at: Instant,
    value: PublicEgressProbe,
}

static PUBLIC_PROBE_CACHE: OnceLock<tokio::sync::Mutex<Option<CachedPublicProbe>>> =
    OnceLock::new();

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct ClashControllerConfig {
    external_controller: Option<String>,
    external_controller_pipe: Option<String>,
    secret: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControllerConnectionsResponse {
    #[serde(default)]
    download_total: u64,
    #[serde(default)]
    upload_total: u64,
    #[serde(default)]
    connections: Vec<ControllerConnection>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControllerConnection {
    #[serde(default)]
    id: String,
    #[serde(default)]
    metadata: ControllerMetadata,
    #[serde(default)]
    upload: u64,
    #[serde(default)]
    download: u64,
    #[serde(default)]
    start: String,
    #[serde(default)]
    chains: Vec<String>,
    #[serde(default)]
    rule: String,
    #[serde(default)]
    rule_payload: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControllerMetadata {
    #[serde(default)]
    network: String,
    #[serde(default, rename = "type")]
    connection_type: String,
    #[serde(default)]
    source_port: Value,
    #[serde(default)]
    destination_ip: String,
    #[serde(default)]
    destination_port: Value,
    #[serde(default)]
    host: String,
    #[serde(default)]
    process: String,
    #[serde(default)]
    process_path: String,
}

#[derive(Debug, Default, Deserialize)]
struct ControllerVersion {
    #[serde(default)]
    meta: bool,
    #[serde(default)]
    version: String,
}

pub async fn get_network_egress_snapshot() -> NetworkEgressSnapshot {
    let proxy_internal = detect_proxy_settings();
    let public_probe_future = cached_public_egress_probe(
        proxy_internal.selected_endpoint.clone(),
        proxy_internal.public.selected_source.clone(),
        proxy_internal.public.listener_reachable,
        proxy_internal.selected_is_pac_only,
    );
    let controller_future = detect_controller();
    let (controller_result, public_probe) = tokio::join!(controller_future, public_probe_future);

    let active_connections = build_active_connection_rows(&controller_result.connections);
    let sources = aggregate_sources(&active_connections);
    let mut warnings = Vec::new();

    if proxy_internal.public.listener_reachable == Some(false) {
        warnings.push(EgressWarning {
            code: "proxy_listener_unreachable".to_string(),
            message: "检测到代理配置，但本地代理端口当前不可连接。".to_string(),
        });
    }
    match controller_result.public.status.as_str() {
        "unavailable" => warnings.push(EgressWarning {
            code: "controller_unavailable".to_string(),
            message: "检测到 Clash/Mihomo 控制器配置，但控制器当前不可访问；线路与规则保持未知。"
                .to_string(),
        }),
        "not_detected" => warnings.push(EgressWarning {
            code: "controller_not_detected".to_string(),
            message: "未发现可验证的 Clash/Mihomo 控制器；不会推测线路或规则。".to_string(),
        }),
        _ => {}
    }
    if controller_result.public.status == "connected" && active_connections.is_empty() {
        warnings.push(EgressWarning {
            code: "no_active_connections".to_string(),
            message: "控制器已连接，但当前没有活跃连接；应用出口保持未观测状态。".to_string(),
        });
    }
    if active_connections
        .iter()
        .any(|connection| connection.process_source == "unresolved")
    {
        warnings.push(EgressWarning {
            code: "process_unresolved".to_string(),
            message: "部分连接未提供进程名，且无法通过 Windows TCP 端口表解析所属进程，已归入“其他”。"
                .to_string(),
        });
    }
    if public_probe.state == "failed" {
        warnings.push(EgressWarning {
            code: "public_probe_failed".to_string(),
            message: "当前应用的公网出口实测失败；未使用占位 IP。".to_string(),
        });
    }

    let observation_state = if !active_connections.is_empty() {
        "measured"
    } else if controller_result.public.status != "not_detected"
        || proxy_internal.public.selected_source.is_some()
        || public_probe.state == "measured"
    {
        "partial"
    } else {
        "unknown"
    };

    NetworkEgressSnapshot {
        captured_at: Utc::now().to_rfc3339(),
        platform: std::env::consts::OS.to_string(),
        observation_state: observation_state.to_string(),
        proxy: proxy_internal.public,
        controller: controller_result.public,
        public_probe,
        sources,
        active_connections,
        warnings,
    }
}

async fn cached_public_egress_probe(
    proxy_endpoint: Option<String>,
    proxy_source: Option<String>,
    listener_reachable: Option<bool>,
    pac_only: bool,
) -> PublicEgressProbe {
    let cache_key = format!(
        "{}|{}|{:?}|{}",
        proxy_endpoint.as_deref().unwrap_or("<direct>"),
        proxy_source.as_deref().unwrap_or("<none>"),
        listener_reachable,
        pac_only
    );
    // Keep the mutex held while the first request is in flight. Concurrent UI polling then waits
    // for that one measurement instead of creating duplicate external requests.
    let cache = PUBLIC_PROBE_CACHE.get_or_init(|| tokio::sync::Mutex::new(None));
    let mut guard = cache.lock().await;
    if let Some(cached) = guard.as_ref() {
        if cached.cache_key == cache_key && cached.captured_at.elapsed() < PUBLIC_PROBE_CACHE_TTL {
            return cached.value.clone();
        }
    }
    let value = probe_public_egress(
        proxy_endpoint,
        proxy_source,
        listener_reachable,
        pac_only,
    )
    .await;
    *guard = Some(CachedPublicProbe {
        cache_key,
        captured_at: Instant::now(),
        value: value.clone(),
    });
    value
}

fn detect_proxy_settings() -> ProxyDetectionInternal {
    let mut candidates = Vec::new();
    candidates.extend(detect_windows_internet_proxy());
    candidates.extend(detect_winhttp_proxy());
    candidates.extend(detect_environment_proxy());

    let selected = candidates
        .iter()
        .find(|candidate| candidate.enabled && (candidate.endpoint.is_some() || candidate.pac_url.is_some()));
    let selected_source = selected.map(|candidate| candidate.source.clone());
    let selected_endpoint_redacted = selected.and_then(|candidate| candidate.endpoint.clone());
    let selected_endpoint = selected_endpoint_redacted
        .as_deref()
        .and_then(unredacted_endpoint_for_selected)
        .or_else(|| selected_endpoint_raw(&candidates, selected));
    let selected_pac_url = selected.and_then(|candidate| candidate.pac_url.clone());
    let listener_reachable = selected.and_then(|candidate| candidate.listener_reachable);
    let selected_is_pac_only = selected
        .map(|candidate| candidate.endpoint.is_none() && candidate.pac_url.is_some())
        .unwrap_or(false);

    ProxyDetectionInternal {
        public: ProxyDetection {
            selected_source,
            selected_endpoint: selected_endpoint_redacted,
            selected_pac_url,
            listener_reachable,
            candidates,
        },
        selected_endpoint,
        selected_is_pac_only,
    }
}

/// Candidate endpoints normally contain no credentials. If credentials are present, the public
/// representation is redacted and cannot be used for the probe. The raw endpoint is recovered by
/// re-reading the authoritative source in selected_endpoint_raw instead.
fn unredacted_endpoint_for_selected(endpoint: &str) -> Option<String> {
    if endpoint.contains("***@") {
        None
    } else {
        Some(endpoint.to_string())
    }
}

fn selected_endpoint_raw(
    candidates: &[ProxyCandidate],
    selected: Option<&ProxyCandidate>,
) -> Option<String> {
    let selected = selected?;
    let source = selected.source.as_str();
    match source {
        "environment" => environment_proxy_endpoint(),
        "windows_internet_settings" => windows_internet_proxy_endpoint(),
        "winhttp" => winhttp_proxy_endpoint(),
        _ => candidates
            .iter()
            .find(|candidate| candidate.source == source)
            .and_then(|candidate| candidate.endpoint.clone()),
    }
}

fn make_proxy_candidate(
    source: &str,
    endpoint: Option<String>,
    pac_url: Option<String>,
    bypass: Option<String>,
    evidence: &str,
) -> ProxyCandidate {
    let listener_reachable = endpoint.as_deref().and_then(proxy_listener_reachable);
    ProxyCandidate {
        source: source.to_string(),
        enabled: endpoint.is_some() || pac_url.is_some(),
        endpoint: endpoint.as_deref().map(redact_proxy_endpoint),
        pac_url,
        bypass,
        listener_reachable,
        evidence: evidence.to_string(),
    }
}

#[cfg(target_os = "windows")]
fn windows_registry_values() -> HashMap<String, String> {
    use std::os::windows::process::CommandExt;

    let mut command = StdCommand::new("reg");
    command.creation_flags(CREATE_NO_WINDOW).args([
        "query",
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
    ]);
    let Ok(output) = command.output() else {
        return HashMap::new();
    };
    if !output.status.success() {
        return HashMap::new();
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_reg_query_values(&stdout)
}

#[cfg(not(target_os = "windows"))]
fn windows_registry_values() -> HashMap<String, String> {
    HashMap::new()
}

fn parse_reg_query_values(output: &str) -> HashMap<String, String> {
    let mut values = HashMap::new();
    for line in output.lines() {
        let trimmed = line.trim();
        let Some(type_index) = ["REG_DWORD", "REG_SZ", "REG_EXPAND_SZ"]
            .iter()
            .filter_map(|kind| trimmed.find(kind).map(|index| (index, *kind)))
            .min_by_key(|(index, _)| *index)
        else {
            continue;
        };
        let name = trimmed[..type_index.0].trim();
        let value = trimmed[type_index.0 + type_index.1.len()..].trim();
        if !name.is_empty() {
            values.insert(name.to_string(), value.to_string());
        }
    }
    values
}

fn registry_dword_enabled(value: Option<&String>) -> bool {
    value
        .map(|value| {
            let value = value.trim();
            u32::from_str_radix(value.trim_start_matches("0x"), 16)
                .map(|parsed| parsed != 0)
                .unwrap_or_else(|_| value == "1")
        })
        .unwrap_or(false)
}

fn windows_internet_proxy_endpoint() -> Option<String> {
    let values = windows_registry_values();
    if !registry_dword_enabled(values.get("ProxyEnable")) {
        return None;
    }
    values
        .get("ProxyServer")
        .and_then(|value| proxy_server_endpoint(value))
}

fn detect_windows_internet_proxy() -> Vec<ProxyCandidate> {
    let values = windows_registry_values();
    if values.is_empty() {
        return Vec::new();
    }
    let endpoint = if registry_dword_enabled(values.get("ProxyEnable")) {
        values
            .get("ProxyServer")
            .and_then(|value| proxy_server_endpoint(value))
    } else {
        None
    };
    let pac_url = values
        .get("AutoConfigURL")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let bypass = values
        .get("ProxyOverride")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if endpoint.is_none() && pac_url.is_none() {
        return Vec::new();
    }
    vec![make_proxy_candidate(
        "windows_internet_settings",
        endpoint,
        pac_url,
        bypass,
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
    )]
}

fn proxy_server_endpoint(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let entries: Vec<(&str, &str)> = value
        .split(';')
        .filter_map(|entry| {
            let entry = entry.trim();
            if entry.is_empty() {
                return None;
            }
            if let Some((kind, endpoint)) = entry.split_once('=') {
                Some((kind.trim(), endpoint.trim()))
            } else {
                Some(("http", entry))
            }
        })
        .collect();
    for preferred in ["https", "http", "socks", "socks5"] {
        if let Some((kind, endpoint)) = entries
            .iter()
            .find(|(kind, _)| kind.eq_ignore_ascii_case(preferred))
        {
            return normalize_proxy_endpoint(endpoint, kind);
        }
    }
    entries
        .first()
        .and_then(|(kind, endpoint)| normalize_proxy_endpoint(endpoint, kind))
}

fn normalize_proxy_endpoint(endpoint: &str, kind: &str) -> Option<String> {
    let endpoint = endpoint.trim().trim_matches('"').trim_matches('\'');
    if endpoint.is_empty() {
        return None;
    }
    let with_scheme = if endpoint.contains("://") {
        endpoint.to_string()
    } else if kind.to_ascii_lowercase().starts_with("socks") {
        format!("socks5://{endpoint}")
    } else {
        format!("http://{endpoint}")
    };
    Url::parse(&with_scheme).ok().map(|url| url.to_string())
}

#[cfg(target_os = "windows")]
fn winhttp_output() -> Option<String> {
    use std::os::windows::process::CommandExt;

    let mut command = StdCommand::new("netsh");
    command
        .creation_flags(CREATE_NO_WINDOW)
        .args(["winhttp", "show", "proxy"]);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(not(target_os = "windows"))]
fn winhttp_output() -> Option<String> {
    None
}

fn winhttp_proxy_endpoint() -> Option<String> {
    winhttp_output().as_deref().and_then(parse_winhttp_endpoint)
}

fn detect_winhttp_proxy() -> Vec<ProxyCandidate> {
    let Some(output) = winhttp_output() else {
        return Vec::new();
    };
    let Some(endpoint) = parse_winhttp_endpoint(&output) else {
        return Vec::new();
    };
    vec![make_proxy_candidate(
        "winhttp",
        Some(endpoint),
        None,
        parse_winhttp_bypass(&output),
        "netsh winhttp show proxy",
    )]
}

fn parse_winhttp_endpoint(output: &str) -> Option<String> {
    for line in output.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.contains("bypass") || line.contains("绕过") {
            continue;
        }
        let Some((_, value)) = line.split_once(':') else {
            continue;
        };
        if let Some(endpoint) = proxy_server_endpoint(value.trim()) {
            return Some(endpoint);
        }
    }
    None
}

fn parse_winhttp_bypass(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let lower = line.to_ascii_lowercase();
        if !lower.contains("bypass") && !line.contains("绕过") {
            return None;
        }
        line.split_once(':')
            .map(|(_, value)| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

const ENV_PROXY_KEYS: [&str; 6] = [
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "HTTP_PROXY",
    "http_proxy",
];

fn environment_proxy_endpoint() -> Option<String> {
    for key in ENV_PROXY_KEYS {
        if let Ok(value) = std::env::var(key) {
            let value = value.trim();
            if !value.is_empty() {
                if let Some(endpoint) = normalize_proxy_endpoint(value, "http") {
                    return Some(endpoint);
                }
            }
        }
    }
    None
}

fn detect_environment_proxy() -> Vec<ProxyCandidate> {
    let Some(endpoint) = environment_proxy_endpoint() else {
        return Vec::new();
    };
    let bypass = std::env::var("NO_PROXY")
        .or_else(|_| std::env::var("no_proxy"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    vec![make_proxy_candidate(
        "environment",
        Some(endpoint),
        None,
        bypass,
        "HTTPS_PROXY / ALL_PROXY / HTTP_PROXY",
    )]
}

fn redact_proxy_endpoint(endpoint: &str) -> String {
    let Ok(mut url) = Url::parse(endpoint) else {
        return endpoint.to_string();
    };
    if !url.username().is_empty() {
        let _ = url.set_username("***");
        let _ = url.set_password(None);
    }
    url.to_string()
}

fn proxy_listener_reachable(endpoint: &str) -> Option<bool> {
    let url = Url::parse(endpoint).ok()?;
    let host = url.host_str()?;
    let port = url.port_or_known_default()?;
    let is_local = host.eq_ignore_ascii_case("localhost")
        || host.parse::<IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false);
    if !is_local {
        return None;
    }
    let addresses = (host, port).to_socket_addrs().ok()?;
    for address in addresses {
        if TcpStream::connect_timeout(&address, CONNECT_TIMEOUT).is_ok() {
            return Some(true);
        }
    }
    Some(false)
}

use std::net::ToSocketAddrs;

async fn probe_public_egress(
    proxy_endpoint: Option<String>,
    proxy_source: Option<String>,
    listener_reachable: Option<bool>,
    pac_only: bool,
) -> PublicEgressProbe {
    if pac_only {
        return PublicEgressProbe {
            state: "not_run".to_string(),
            public_ip: None,
            country_code: None,
            via_proxy: false,
            proxy_source,
            scope: "backend_process".to_string(),
            provider: None,
            error: Some("检测到 PAC 自动代理，但未解析目标 URL 的实际代理，已跳过出口探测。".to_string()),
        };
    }
    if proxy_endpoint.is_some() && listener_reachable == Some(false) {
        return PublicEgressProbe {
            state: "not_run".to_string(),
            public_ip: None,
            country_code: None,
            via_proxy: true,
            proxy_source,
            scope: "backend_process".to_string(),
            provider: None,
            error: Some("代理监听端口不可连接，已跳过公网出口探测。".to_string()),
        };
    }

    let mut builder = Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(3))
        .timeout(PUBLIC_PROBE_TIMEOUT)
        .user_agent("C.le.Console-EgressProbe/1");
    if let Some(endpoint) = proxy_endpoint.as_deref() {
        match Proxy::all(endpoint) {
            Ok(proxy) => builder = builder.proxy(proxy),
            Err(error) => {
                return failed_public_probe(
                    proxy_source,
                    true,
                    format!("代理地址无效: {error}"),
                )
            }
        }
    }
    let client = match builder.build() {
        Ok(client) => client,
        Err(error) => {
            return failed_public_probe(
                proxy_source,
                proxy_endpoint.is_some(),
                format!("无法创建探测客户端: {error}"),
            )
        }
    };
    let response = match client
        .get("https://www.cloudflare.com/cdn-cgi/trace")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return failed_public_probe(
                proxy_source,
                proxy_endpoint.is_some(),
                format!("出口探测请求失败: {error}"),
            )
        }
    };
    if !response.status().is_success() {
        return failed_public_probe(
            proxy_source,
            proxy_endpoint.is_some(),
            format!("出口探测返回 HTTP {}", response.status()),
        );
    }
    let body = match response.text().await {
        Ok(body) => body,
        Err(error) => {
            return failed_public_probe(
                proxy_source,
                proxy_endpoint.is_some(),
                format!("无法读取出口探测响应: {error}"),
            )
        }
    };
    let trace = parse_cloudflare_trace(&body);
    let public_ip = trace
        .get("ip")
        .filter(|value| value.parse::<IpAddr>().is_ok())
        .cloned();
    if public_ip.is_none() {
        return failed_public_probe(
            proxy_source,
            proxy_endpoint.is_some(),
            "出口探测响应没有有效公网 IP".to_string(),
        );
    }
    let country_code = trace
        .get("loc")
        .map(|value| value.trim().to_ascii_uppercase())
        .filter(|value| value.len() == 2);
    PublicEgressProbe {
        state: "measured".to_string(),
        public_ip,
        country_code,
        via_proxy: proxy_endpoint.is_some(),
        proxy_source,
        scope: "backend_process".to_string(),
        provider: Some("cloudflare_trace".to_string()),
        error: None,
    }
}

fn failed_public_probe(
    proxy_source: Option<String>,
    via_proxy: bool,
    error: String,
) -> PublicEgressProbe {
    PublicEgressProbe {
        state: "failed".to_string(),
        public_ip: None,
        country_code: None,
        via_proxy,
        proxy_source,
        scope: "backend_process".to_string(),
        provider: Some("cloudflare_trace".to_string()),
        error: Some(error),
    }
}

fn parse_cloudflare_trace(body: &str) -> HashMap<String, String> {
    body.lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
        .collect()
}

async fn detect_controller() -> ControllerResult {
    let targets = discover_controller_targets();
    if targets.is_empty() {
        return ControllerResult {
            public: ControllerDetection {
                status: "not_detected".to_string(),
                transport: None,
                endpoint: None,
                implementation: None,
                version: None,
                config_path: None,
                active_connections: 0,
                download_total: 0,
                upload_total: 0,
                error: None,
            },
            connections: Vec::new(),
        };
    }

    let mut first_error = None;
    let mut first_target = None;
    for target in &targets {
        if first_target.is_none() {
            first_target = Some(target.clone());
        }
        match controller_get_json::<ControllerConnectionsResponse>(target, "/connections").await {
            Ok(response) => {
                let version = controller_get_json::<ControllerVersion>(target, "/version")
                    .await
                    .ok();
                let implementation = version.as_ref().map(|version| {
                    if version.meta {
                        "mihomo"
                    } else {
                        "clash-compatible"
                    }
                    .to_string()
                });
                return ControllerResult {
                    public: ControllerDetection {
                        status: "connected".to_string(),
                        transport: Some(controller_transport_code(&target.transport).to_string()),
                        endpoint: Some(target.endpoint.clone()),
                        implementation: implementation.or_else(|| Some("clash-compatible".to_string())),
                        version: version
                            .map(|version| version.version)
                            .filter(|version| !version.is_empty()),
                        config_path: target
                            .config_path
                            .as_ref()
                            .map(|path| path.to_string_lossy().into_owned()),
                        active_connections: response.connections.len(),
                        download_total: response.download_total,
                        upload_total: response.upload_total,
                        error: None,
                    },
                    connections: response.connections,
                };
            }
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }
    let target = first_target.expect("controller target list is not empty");
    ControllerResult {
        public: ControllerDetection {
            status: "unavailable".to_string(),
            transport: Some(controller_transport_code(&target.transport).to_string()),
            endpoint: Some(target.endpoint.clone()),
            implementation: None,
            version: None,
            config_path: target
                .config_path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            active_connections: 0,
            download_total: 0,
            upload_total: 0,
            error: first_error,
        },
        connections: Vec::new(),
    }
}

fn controller_transport_code(transport: &ControllerTransport) -> &'static str {
    match transport {
        ControllerTransport::Tcp => "tcp",
        ControllerTransport::NamedPipe => "named_pipe",
    }
}

fn known_controller_config_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
    let local_appdata = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let home = dirs::home_dir();
    if let Some(appdata) = appdata {
        for relative in [
            r"io.github.clash-verge-rev.clash-verge-rev\config.yaml",
            r"io.github.clash-verge-rev.clash-verge-rev\clash-verge.yaml",
            r"clash-verge\config.yaml",
            r"Clash Verge\config.yaml",
        ] {
            paths.push(appdata.join(relative));
        }
    }
    if let Some(local_appdata) = local_appdata {
        paths.push(local_appdata.join(r"Clash Verge\config.yaml"));
    }
    if let Some(home) = home {
        paths.push(home.join(r".config\mihomo\config.yaml"));
        paths.push(home.join(r".config\clash\config.yaml"));
    }
    paths
}

fn discover_controller_targets() -> Vec<ControllerTarget> {
    let mut targets = Vec::new();
    let mut secrets = Vec::new();
    for path in known_controller_config_paths() {
        if !path.is_file() {
            continue;
        }
        let Ok(contents) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(config) = serde_yaml::from_str::<ClashControllerConfig>(&contents) else {
            continue;
        };
        let secret = config.secret.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
        if let Some(secret) = secret.clone() {
            if !secrets.contains(&secret) {
                secrets.push(secret);
            }
        }
        if let Some(pipe) = config
            .external_controller_pipe
            .map(|value| value.trim().to_string())
            .filter(|value| valid_named_pipe_path(value))
        {
            targets.push(ControllerTarget {
                transport: ControllerTransport::NamedPipe,
                endpoint: pipe,
                secret: secret.clone(),
                config_path: Some(path.clone()),
            });
        }
        if let Some(endpoint) = config
            .external_controller
            .as_deref()
            .and_then(normalize_local_controller_endpoint)
        {
            targets.push(ControllerTarget {
                transport: ControllerTransport::Tcp,
                endpoint,
                secret,
                config_path: Some(path),
            });
        }
    }

    // A controller can be enabled at runtime even when its generated config has not yet been
    // persisted. Probe only the small, evidence-based set of common loopback ports.
    if targets.is_empty() {
        let secrets_to_try: Vec<Option<String>> = if secrets.is_empty() {
            vec![None]
        } else {
            secrets.into_iter().map(Some).chain(std::iter::once(None)).collect()
        };
        for port in [9097_u16, 9090, 9093] {
            for secret in &secrets_to_try {
                targets.push(ControllerTarget {
                    transport: ControllerTransport::Tcp,
                    endpoint: format!("http://127.0.0.1:{port}"),
                    secret: secret.clone(),
                    config_path: None,
                });
            }
        }
    }
    deduplicate_controller_targets(targets)
}

fn deduplicate_controller_targets(targets: Vec<ControllerTarget>) -> Vec<ControllerTarget> {
    let mut seen = BTreeSet::new();
    let mut targets: Vec<ControllerTarget> = targets
        .into_iter()
        .filter(|target| {
            let key = format!(
                "{}|{}|{}",
                controller_transport_code(&target.transport),
                target.endpoint.to_ascii_lowercase(),
                target.secret.as_deref().unwrap_or("")
            );
            seen.insert(key)
        })
        .collect();
    // Clash Verge Rev commonly persists a stale TCP controller beside its live named pipe.
    // Try the authoritative pipe first so polling does not pay a TCP timeout on every refresh.
    targets.sort_by_key(|target| match target.transport {
        ControllerTransport::NamedPipe => 0_u8,
        ControllerTransport::Tcp => 1_u8,
    });
    targets
}

fn valid_named_pipe_path(path: &str) -> bool {
    let normalized = path.replace('/', "\\").to_ascii_lowercase();
    normalized.starts_with(r"\\.\pipe\")
        && normalized.len() > r"\\.\pipe\".len()
        && !normalized[r"\\.\pipe\".len()..].contains("..")
}

fn normalize_local_controller_endpoint(value: &str) -> Option<String> {
    let value = value.trim().trim_matches('"').trim_matches('\'');
    if value.is_empty() {
        return None;
    }
    let with_scheme = if value.contains("://") {
        value.to_string()
    } else {
        format!("http://{value}")
    };
    let mut url = Url::parse(&with_scheme).ok()?;
    let host = url.host_str()?.to_string();
    if host == "0.0.0.0" {
        url.set_host(Some("127.0.0.1")).ok()?;
    } else if host == "::" || host == "[::]" {
        url.set_host(Some("::1")).ok()?;
    } else {
        let local = host.eq_ignore_ascii_case("localhost")
            || host.parse::<IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false);
        if !local {
            return None;
        }
    }
    if url.port().is_none() {
        return None;
    }
    Some(url.to_string().trim_end_matches('/').to_string())
}

async fn controller_get_json<T>(target: &ControllerTarget, path: &str) -> Result<T, String>
where
    T: serde::de::DeserializeOwned + Send + 'static,
{
    let bytes = match target.transport {
        ControllerTransport::Tcp => controller_http_tcp(target, path).await?,
        ControllerTransport::NamedPipe => {
            let target = target.clone();
            let path = path.to_string();
            tokio::task::spawn_blocking(move || controller_http_named_pipe(&target, &path))
                .await
                .map_err(|error| format!("控制器管道任务失败: {error}"))??
        }
    };
    serde_json::from_slice(&bytes).map_err(|error| format!("控制器响应 JSON 无效: {error}"))
}

async fn controller_http_tcp(target: &ControllerTarget, path: &str) -> Result<Vec<u8>, String> {
    let client = Client::builder()
        .no_proxy()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(CONTROLLER_TIMEOUT)
        .build()
        .map_err(|error| format!("无法创建控制器客户端: {error}"))?;
    let url = format!("{}{}", target.endpoint.trim_end_matches('/'), path);
    let mut request = client.get(url);
    if let Some(secret) = target.secret.as_deref() {
        request = request.bearer_auth(secret);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("控制器连接失败: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("控制器返回 HTTP {}", response.status()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取控制器响应失败: {error}"))?;
    if bytes.len() > MAX_CONTROLLER_RESPONSE_BYTES {
        return Err("控制器响应超过安全上限".to_string());
    }
    Ok(bytes.to_vec())
}

fn controller_http_named_pipe(target: &ControllerTarget, path: &str) -> Result<Vec<u8>, String> {
    if !valid_named_pipe_path(&target.endpoint) {
        return Err("控制器管道路径无效".to_string());
    }
    if path.contains(['\r', '\n', ' ']) {
        return Err("控制器请求路径无效".to_string());
    }
    let secret = target.secret.as_deref().unwrap_or("");
    if secret.contains(['\r', '\n']) {
        return Err("控制器密钥格式无效".to_string());
    }
    let mut pipe = None;
    let mut last_error = None;
    for _ in 0..4 {
        match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&target.endpoint)
        {
            Ok(file) => {
                pipe = Some(file);
                break;
            }
            Err(error) => {
                last_error = Some(error);
                std::thread::sleep(Duration::from_millis(60));
            }
        }
    }
    let mut pipe = pipe.ok_or_else(|| {
        format!(
            "无法连接控制器命名管道: {}",
            last_error
                .map(|error| error.to_string())
                .unwrap_or_else(|| "unknown error".to_string())
        )
    })?;
    let authorization = if secret.is_empty() {
        String::new()
    } else {
        format!("Authorization: Bearer {secret}\r\n")
    };
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: localhost\r\n{authorization}Accept: application/json\r\nConnection: close\r\n\r\n"
    );
    pipe.write_all(request.as_bytes())
        .map_err(|error| format!("写入控制器管道失败: {error}"))?;
    pipe.flush()
        .map_err(|error| format!("刷新控制器管道失败: {error}"))?;
    read_http_response(&mut pipe)
}

fn read_http_response(reader: &mut impl Read) -> Result<Vec<u8>, String> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 8192];
    let mut header_end = None;
    let mut content_length = None;
    let mut chunked = false;
    loop {
        let count = reader
            .read(&mut chunk)
            .map_err(|error| format!("读取控制器管道失败: {error}"))?;
        if count == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..count]);
        if buffer.len() > MAX_CONTROLLER_RESPONSE_BYTES {
            return Err("控制器响应超过安全上限".to_string());
        }
        if header_end.is_none() {
            if let Some(index) = find_bytes(&buffer, b"\r\n\r\n") {
                let end = index + 4;
                let headers = String::from_utf8_lossy(&buffer[..end]);
                let status = headers.lines().next().unwrap_or_default();
                let status_code = status
                    .split_whitespace()
                    .nth(1)
                    .and_then(|value| value.parse::<u16>().ok())
                    .unwrap_or(0);
                if !(200..300).contains(&status_code) {
                    return Err(format!("控制器返回 HTTP {status_code}"));
                }
                for line in headers.lines().skip(1) {
                    let Some((name, value)) = line.split_once(':') else {
                        continue;
                    };
                    if name.eq_ignore_ascii_case("content-length") {
                        content_length = value.trim().parse::<usize>().ok();
                    } else if name.eq_ignore_ascii_case("transfer-encoding")
                        && value.to_ascii_lowercase().contains("chunked")
                    {
                        chunked = true;
                    }
                }
                header_end = Some(end);
            }
        }
        if let Some(end) = header_end {
            let body = &buffer[end..];
            if let Some(expected) = content_length {
                if body.len() >= expected {
                    return Ok(body[..expected].to_vec());
                }
            } else if chunked && chunked_message_complete(body) {
                return decode_chunked_body(body);
            }
        }
    }
    let Some(end) = header_end else {
        return Err("控制器响应缺少 HTTP 头".to_string());
    };
    let body = &buffer[end..];
    if let Some(expected) = content_length {
        if body.len() < expected {
            return Err("控制器响应正文不完整".to_string());
        }
        Ok(body[..expected].to_vec())
    } else if chunked {
        decode_chunked_body(body)
    } else {
        Ok(body.to_vec())
    }
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn chunked_message_complete(body: &[u8]) -> bool {
    body.ends_with(b"0\r\n\r\n") || find_bytes(body, b"\r\n0\r\n\r\n").is_some()
}

fn decode_chunked_body(body: &[u8]) -> Result<Vec<u8>, String> {
    let mut cursor = 0;
    let mut decoded = Vec::new();
    loop {
        let relative_end = find_bytes(&body[cursor..], b"\r\n")
            .ok_or_else(|| "分块响应长度行不完整".to_string())?;
        let line_end = cursor + relative_end;
        let size_line = std::str::from_utf8(&body[cursor..line_end])
            .map_err(|_| "分块响应长度不是 UTF-8".to_string())?;
        let size = usize::from_str_radix(size_line.split(';').next().unwrap_or(""), 16)
            .map_err(|_| "分块响应长度无效".to_string())?;
        cursor = line_end + 2;
        if size == 0 {
            return Ok(decoded);
        }
        if body.len() < cursor + size + 2 {
            return Err("分块响应正文不完整".to_string());
        }
        decoded.extend_from_slice(&body[cursor..cursor + size]);
        cursor += size;
        if &body[cursor..cursor + 2] != b"\r\n" {
            return Err("分块响应缺少结束符".to_string());
        }
        cursor += 2;
    }
}

fn build_active_connection_rows(
    controller_connections: &[ControllerConnection],
) -> Vec<EgressActiveConnection> {
    let port_owners = tcp_port_owner_map();
    let process_names = process_name_map();
    controller_connections
        .iter()
        .enumerate()
        .map(|(index, connection)| {
            let source_port = json_u16(&connection.metadata.source_port);
            let (process, process_id, process_source) = resolve_connection_process(
                &connection.metadata,
                source_port,
                &port_owners,
                &process_names,
            );
            let source = classify_source(process.as_deref()).to_string();
            let chains: Vec<String> = connection
                .chains
                .iter()
                .map(|chain| chain.trim().to_string())
                .filter(|chain| !chain.is_empty())
                .collect();
            let route = if chains.is_empty() {
                None
            } else {
                Some(chains.iter().rev().cloned().collect::<Vec<_>>().join(" / "))
            };
            let node = chains.first().cloned();
            let rule = format_controller_rule(&connection.rule, &connection.rule_payload);
            let destination_port = json_u16(&connection.metadata.destination_port);
            let destination = if !connection.metadata.host.trim().is_empty() {
                connection.metadata.host.trim().to_string()
            } else if !connection.metadata.destination_ip.trim().is_empty() {
                connection.metadata.destination_ip.trim().to_string()
            } else {
                "unknown".to_string()
            };
            let target = destination_port
                .map(|port| format_target(&destination, port))
                .unwrap_or(destination);
            let protocol = if !connection.metadata.network.trim().is_empty() {
                connection.metadata.network.trim().to_ascii_uppercase()
            } else if !connection.metadata.connection_type.trim().is_empty() {
                connection.metadata.connection_type.trim().to_ascii_uppercase()
            } else {
                "UNKNOWN".to_string()
            };
            EgressActiveConnection {
                id: if connection.id.trim().is_empty() {
                    format!("controller-{index:04}")
                } else {
                    connection.id.clone()
                },
                source,
                process,
                process_id,
                process_source,
                source_port,
                target,
                protocol,
                route,
                node,
                chains,
                rule,
                download_bytes: connection.download,
                upload_bytes: connection.upload,
                start: if connection.start.trim().is_empty() {
                    None
                } else {
                    Some(connection.start.clone())
                },
                observation_state: "controller_observed".to_string(),
            }
        })
        .collect()
}

fn json_u16(value: &Value) -> Option<u16> {
    match value {
        Value::Number(number) => number.as_u64().and_then(|number| u16::try_from(number).ok()),
        Value::String(value) => value.parse::<u16>().ok(),
        _ => None,
    }
}

fn resolve_connection_process(
    metadata: &ControllerMetadata,
    source_port: Option<u16>,
    port_owners: &HashMap<u16, u32>,
    process_names: &HashMap<u32, String>,
) -> (Option<String>, Option<u32>, String) {
    let controller_name = normalize_process_name(&metadata.process)
        .or_else(|| normalize_process_name(&metadata.process_path));
    if let Some(name) = controller_name {
        let process_id = source_port.and_then(|port| port_owners.get(&port).copied());
        return (Some(name), process_id, "controller_metadata".to_string());
    }
    if let Some((pid, name)) = source_port
        .and_then(|port| port_owners.get(&port).copied())
        .and_then(|pid| process_names.get(&pid).cloned().map(|name| (pid, name)))
    {
        return (Some(name), Some(pid), "windows_tcp_owner".to_string());
    }
    (None, None, "unresolved".to_string())
}

fn normalize_process_name(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("unknown") {
        return None;
    }
    Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_string())
        .or_else(|| Some(value.to_string()))
}

fn classify_source(process: Option<&str>) -> &'static str {
    let process = process.unwrap_or("").to_ascii_lowercase();
    if process.contains("cle-cliproxy") {
        "local-api"
    } else if process.contains("chatgpt") {
        "chatgpt"
    } else if process.contains("claude") {
        "claude"
    } else {
        "other"
    }
}

fn format_controller_rule(rule: &str, payload: &str) -> Option<String> {
    let rule = rule.trim();
    let payload = payload.trim();
    if rule.is_empty() {
        return None;
    }
    if payload.is_empty() {
        Some(rule.to_string())
    } else {
        Some(format!("{rule}({payload})"))
    }
}

fn format_target(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn aggregate_sources(connections: &[EgressActiveConnection]) -> Vec<EgressSourceSnapshot> {
    ["local-api", "chatgpt", "claude", "other"]
        .iter()
        .map(|source_id| {
            let matching: Vec<&EgressActiveConnection> = connections
                .iter()
                .filter(|connection| connection.source == *source_id)
                .collect();
            let process_names = unique_nonempty(matching.iter().filter_map(|item| item.process.clone()));
            let routes = unique_nonempty(matching.iter().filter_map(|item| item.route.clone()));
            let nodes = unique_nonempty(matching.iter().filter_map(|item| item.node.clone()));
            let rules = unique_nonempty(matching.iter().filter_map(|item| item.rule.clone()));
            EgressSourceSnapshot {
                id: (*source_id).to_string(),
                observation_state: if matching.is_empty() {
                    "not_observed"
                } else {
                    "controller_observed"
                }
                .to_string(),
                process_names,
                routes,
                nodes,
                rules,
                active_connections: matching.len(),
                download_bytes: matching.iter().map(|item| item.download_bytes).sum(),
                upload_bytes: matching.iter().map(|item| item.upload_bytes).sum(),
                public_ip: None,
            }
        })
        .collect()
}

fn unique_nonempty(values: impl Iterator<Item = String>) -> Vec<String> {
    values
        .filter(|value| !value.trim().is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn process_name_map() -> HashMap<u32, String> {
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing(),
    );
    system
        .processes()
        .iter()
        .map(|(pid, process)| {
            (
                pid.as_u32(),
                process.name().to_string_lossy().into_owned(),
            )
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn tcp_port_owner_map() -> HashMap<u16, u32> {
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_ALL,
    };
    use windows::Win32::Networking::WinSock::AF_INET;

    let mut size = 0_u32;
    let first = unsafe {
        GetExtendedTcpTable(
            None,
            &mut size,
            false,
            AF_INET.0 as u32,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    };
    if first != 122 || size < 4 {
        return HashMap::new();
    }
    let word_count = (size as usize + std::mem::size_of::<u32>() - 1)
        / std::mem::size_of::<u32>();
    let mut buffer = vec![0_u32; word_count];
    let result = unsafe {
        GetExtendedTcpTable(
            Some(buffer.as_mut_ptr().cast()),
            &mut size,
            false,
            AF_INET.0 as u32,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    };
    if result != 0 {
        return HashMap::new();
    }
    let count = buffer[0] as usize;
    let rows = unsafe {
        std::slice::from_raw_parts(
            buffer.as_ptr().add(1).cast::<MIB_TCPROW_OWNER_PID>(),
            count,
        )
    };
    rows.iter()
        .filter_map(|row| {
            let port = u16::from_be((row.dwLocalPort & 0xffff) as u16);
            (port != 0).then_some((port, row.dwOwningPid))
        })
        .collect()
}

#[cfg(not(target_os = "windows"))]
fn tcp_port_owner_map() -> HashMap<u16, u32> {
    HashMap::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn parses_windows_registry_proxy_values() {
        let values = parse_reg_query_values(
            r#"
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:7897
    ProxyOverride    REG_SZ    localhost;127.*
"#,
        );
        assert_eq!(values.get("ProxyEnable").map(String::as_str), Some("0x1"));
        assert_eq!(
            values.get("ProxyServer").map(String::as_str),
            Some("127.0.0.1:7897")
        );
    }

    #[test]
    fn selects_https_proxy_from_wininet_server_list() {
        assert_eq!(
            proxy_server_endpoint("http=127.0.0.1:7899;https=127.0.0.1:7897;socks=127.0.0.1:7898")
                .as_deref(),
            Some("http://127.0.0.1:7897/")
        );
    }

    #[test]
    fn parses_local_winhttp_proxy_without_matching_heading() {
        let output = r#"
Current WinHTTP proxy settings:

    Proxy Server(s) :  127.0.0.1:7897
    Bypass List     :  localhost;127.0.0.1
"#;
        assert_eq!(
            parse_winhttp_endpoint(output).as_deref(),
            Some("http://127.0.0.1:7897/")
        );
        assert_eq!(
            parse_winhttp_bypass(output).as_deref(),
            Some("localhost;127.0.0.1")
        );
    }

    #[test]
    fn only_accepts_local_controller_endpoints() {
        assert_eq!(
            normalize_local_controller_endpoint("127.0.0.1:9097").as_deref(),
            Some("http://127.0.0.1:9097")
        );
        assert!(normalize_local_controller_endpoint("192.0.2.55:9090").is_none());
    }

    #[test]
    fn accepts_verge_named_pipe_and_rejects_file_paths() {
        assert!(valid_named_pipe_path(r"\\.\pipe\verge-mihomo"));
        assert!(!valid_named_pipe_path(r"C:\temp\controller.json"));
        assert!(!valid_named_pipe_path(r"\\.\pipe\..\unsafe"));
    }

    #[test]
    fn parses_content_length_http_response() {
        let response = b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}";
        let mut cursor = Cursor::new(response);
        assert_eq!(read_http_response(&mut cursor).unwrap(), br#"{"ok":true}"#);
    }

    #[test]
    fn parses_chunked_http_response() {
        let response = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"ok\r\n7\r\n\":true}\r\n0\r\n\r\n";
        let mut cursor = Cursor::new(response);
        assert_eq!(read_http_response(&mut cursor).unwrap(), br#"{"ok":true}"#);
    }

    #[test]
    fn route_uses_controller_chain_order_without_inventing_names() {
        let connection = ControllerConnection {
            id: "real-id".to_string(),
            chains: vec!["日本₃".to_string(), "GLOBAL".to_string()],
            ..ControllerConnection::default()
        };
        let rows = build_active_connection_rows(&[connection]);
        assert_eq!(rows[0].route.as_deref(), Some("GLOBAL / 日本₃"));
        assert_eq!(rows[0].node.as_deref(), Some("日本₃"));
        assert!(rows[0].rule.is_none());
    }

    #[test]
    fn classifies_only_observed_process_names() {
        assert_eq!(classify_source(Some("cle-cliproxy.exe")), "local-api");
        assert_eq!(classify_source(Some("ChatGPT.exe")), "chatgpt");
        assert_eq!(classify_source(Some("Claude.exe")), "claude");
        assert_eq!(classify_source(None), "other");
    }

    #[test]
    fn empty_sources_remain_not_observed() {
        let sources = aggregate_sources(&[]);
        assert_eq!(sources.len(), 4);
        assert!(sources
            .iter()
            .all(|source| source.observation_state == "not_observed"));
        assert!(sources.iter().all(|source| source.public_ip.is_none()));
    }

}
