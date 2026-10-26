//! Credential journals and runtime state have different lifetimes.
//! A received token pair is durable before quota requests begin. Runtime errors
//! never rotate credential history; recovery never invents or resurrects an ID.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const HISTORY_LIMIT: usize = 8;
pub(super) fn refresh_rejected(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    [
        "invalid_grant",
        "refresh token is invalid",
        "invalid refresh token",
        "refresh_token_rejected",
        "code=12153",
    ]
    .iter()
    .any(|marker| message.contains(marker))
}
const CREDENTIAL_FIELDS: &[&str] = &[
    "access_token",
    "refresh_token",
    "token_type",
    "expires_at",
    "refresh_expires_at",
    "domain",
    "auth_raw",
    "token_refreshed_at",
    "auth_mode",
    "claude_credentials_raw",
    "claude_config_raw",
    "api_key",
    "api_base_url",
    "desktop_profile_dir",
    "desktop_profile_imported_at",
    "desktop_gateway_profile_dir",
    "desktop_gateway_auth_scheme",
    "uid",
    "enterprise_id",
    "account_uuid",
    "organization_uuid",
    "credential_owner",
    "credential_source_dir",
];
const RUNTIME_FIELDS: &[&str] = &[
    "status",
    "status_reason",
    "quota_query_last_error",
    "quota_query_last_error_at",
    "token_refresh_last_error",
    "usage_updated_at",
    "quota_raw",
    "usage_raw",
    "plan_type",
    "dosage_notify_code",
    "dosage_notify_zh",
    "dosage_notify_en",
    "payment_type",
    "last_used",
    "quota",
    "quota_error",
    "claude_usage_raw",
    "profile_updated_at",
];

pub(super) fn fingerprint(record: &Value) -> String {
    let mut parts: Vec<_> = [
        "id",
        "uid",
        "enterprise_id",
        "access_token",
        "refresh_token",
        "domain",
        "token_type",
        "expires_at",
        "refresh_expires_at",
        "auth_mode",
        "account_uuid",
        "organization_uuid",
        "api_key",
        "api_base_url",
        "desktop_profile_dir",
        "desktop_gateway_profile_dir",
        "desktop_gateway_auth_scheme",
    ]
    .iter()
    .map(|key| record.get(key).cloned().unwrap_or(Value::Null))
    .collect();
    parts.push(
        record
            .pointer("/claude_credentials_raw/claudeAiOauth")
            .cloned()
            .unwrap_or(Value::Null),
    );
    format!(
        "{:x}",
        Sha256::digest(Value::Array(parts).to_string().as_bytes())
    )
}

fn record_id(path: &Path) -> Result<&str, String> {
    let id = path
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or("账号路径无效")?;
    if id.is_empty()
        || id.contains("..")
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
    {
        return Err("账号 ID 包含非法路径字符".into());
    }
    Ok(id)
}

fn state_dir(path: &Path) -> Result<PathBuf, String> {
    Ok(path
        .parent()
        .ok_or("账号目录不存在")?
        .join(".state")
        .join(record_id(path)?))
}

fn private_dir(path: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|_| "无法创建账号私有存储目录")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "无法保护账号目录权限")?;
    }
    Ok(())
}

fn read_json(path: &Path) -> Result<Value, String> {
    let bytes = fs::read(path).map_err(|_| "账号存储文件无法读取")?;
    serde_json::from_slice(&bytes).map_err(|_| "账号存储文件损坏；原文件已保留".into())
}

fn valid_record(record: &Value, id: &str) -> bool {
    let present = |pointer: &str| {
        record
            .pointer(pointer)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    };
    let credentials_present = if record.get("access_token").is_some() {
        present("/access_token")
    } else {
        match record
            .get("auth_mode")
            .and_then(Value::as_str)
            .unwrap_or("oauth")
        {
            "oauth" | "o_auth" | "setup_token" => {
                present("/claude_credentials_raw/claudeAiOauth/accessToken")
            }
            "api_key" => present("/api_key"),
            "desktop_oauth" | "desktop_o_auth" => present("/desktop_profile_dir"),
            "desktop_gateway" => {
                present("/api_key")
                    || present("/desktop_gateway_profile_dir")
                    || present("/api_base_url")
            }
            _ => false,
        }
    };
    record.get("id").and_then(Value::as_str) == Some(id)
        && record.get("email").and_then(Value::as_str).is_some()
        && record.get("created_at").and_then(Value::as_i64).is_some()
        && record.get("last_used").and_then(Value::as_i64).is_some()
        && record.is_object()
        && credentials_present
}

fn durable_write(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or("账号目录不存在")?;
    private_dir(parent)?;
    let content = serde_json::to_string_pretty(value).map_err(|_| "账号数据序列化失败")?;
    crate::modules::atomic_write::write_private_string_atomic(path, &content)?;
    // File data was fsynced before rename. Sync its directory entry as well.
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|dir| dir.sync_all())
        .map_err(|_| "账号文件已写入，但目录同步失败；请检查磁盘，不要重复刷新凭证")?;
    Ok(())
}

fn journal_record(value: Value, id: &str) -> Option<Value> {
    (value.get("schema_version").and_then(Value::as_u64) == Some(1)
        && value.get("record").is_some_and(|record| {
            valid_record(record, id)
                && value.get("fingerprint").and_then(Value::as_str)
                    == Some(fingerprint(record).as_str())
        }))
    .then_some(value)
}

fn journal(path: &Path) -> Option<Value> {
    let id = record_id(path).ok()?;
    let directory = state_dir(path).ok()?;
    if let Some(current) = read_json(&directory.join("credentials.json"))
        .ok()
        .and_then(|value| journal_record(value, id))
    {
        return Some(current);
    }
    // Corrupt journal: immutable generations are a second recovery source.
    let mut histories: Vec<_> = fs::read_dir(directory.join("history"))
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .collect();
    histories.sort_by_key(|entry| entry.metadata().and_then(|meta| meta.modified()).ok());
    histories.into_iter().rev().find_map(|entry| {
        read_json(&entry.path())
            .ok()
            .and_then(|value| journal_record(value, id))
    })
}

fn read_base(path: &Path) -> Result<Value, String> {
    let id = record_id(path)?;
    if !path.exists() {
        // Explicitly removed records are never brought back by a stale journal.
        return Err("账号文件不存在；未从历史自动重新创建账号".into());
    }
    let current = read_json(path)
        .ok()
        .filter(|record| valid_record(record, id));
    let recovery = journal(path);
    match (current, recovery) {
        (Some(mut current), Some(recovery)) => {
            let same_generation = fingerprint(&current) == fingerprint(&recovery["record"]);
            let interrupted_commit = recovery.get("previous_fingerprint").and_then(Value::as_str)
                == Some(fingerprint(&current).as_str());
            if !same_generation && interrupted_commit {
                // Preserve current labels/check-ins/profile while replaying only
                // the acknowledged token pair. Unrelated external edits win.
                for key in CREDENTIAL_FIELDS {
                    if let Some(value) = recovery["record"].get(key) {
                        current[*key] = value.clone();
                    } else {
                        current.as_object_mut().map(|object| object.remove(*key));
                    }
                }
                current["status"] = recovery["record"]
                    .get("status")
                    .cloned()
                    .unwrap_or(Value::Null);
                current["status_reason"] = recovery["record"]
                    .get("status_reason")
                    .cloned()
                    .unwrap_or(Value::Null);
                current["token_refresh_last_error"] = Value::Null;
            }
            Ok(current)
        }
        (Some(current), None) => Ok(current),
        (None, Some(recovery)) => Ok(recovery["record"].clone()),
        (None, None) => {
            let backup = PathBuf::from(format!("{}.bak", path.to_string_lossy()));
            read_json(&backup)
                .ok()
                .filter(|record| valid_record(record, id))
                .ok_or_else(|| "账号详情及恢复记录无法读取；已保留原文件，禁止按空账号覆盖".into())
        }
    }
}

pub(super) fn load(path: &Path) -> Result<Value, String> {
    let mut record = read_base(path)?;
    let runtime = read_json(&state_dir(path)?.join("runtime.json")).ok();
    if let Some(runtime) = runtime.filter(|state| {
        state.get("fingerprint").and_then(Value::as_str) == Some(fingerprint(&record).as_str())
    }) {
        for key in RUNTIME_FIELDS {
            if let Some(value) = runtime["state"].get(key) {
                record[*key] = value.clone();
            } else {
                record.as_object_mut().map(|object| object.remove(*key));
            }
        }
    }
    Ok(record)
}

fn envelope(record: &Value, previous: Option<&Value>) -> Value {
    json!({"schema_version":1, "saved_at_ms":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
        "fingerprint":fingerprint(record), "previous_fingerprint":previous.map(fingerprint), "record":record})
}

fn archive(path: &Path, snapshot: &Value) -> Result<(), String> {
    let target = state_dir(path)?
        .join("history")
        .join(format!("{}.json", fingerprint(&snapshot["record"])));
    if !target.exists() {
        durable_write(&target, snapshot)?;
    }
    Ok(())
}

/// Before a remote rotation, prove storage is writable and preserve its current
/// generation. No HTTP request should be made if this fails.
pub(super) fn prepare_refresh(path: &Path, expected: &Value) -> Result<(), String> {
    let current = load(path)?;
    if fingerprint(&current) != fingerprint(expected) {
        return Err("账号凭证已被更新；未启动旧凭证刷新".into());
    }
    archive(path, &envelope(&current, None))?;
    // Reconcile an earlier interrupted primary write before another rotation.
    durable_write(path, &current)
}

pub(super) fn save(path: &Path, record: &Value) -> Result<(), String> {
    commit_with(path, record, || Ok(()))
}

fn commit_with(
    path: &Path,
    record: &Value,
    before_primary: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if !valid_record(record, record_id(path)?) {
        return Err("账号身份或凭证无效；未覆盖原文件".into());
    }
    let previous = if path.exists() {
        Some(load(path)?)
    } else {
        None
    };
    let changed = previous
        .as_ref()
        .is_none_or(|old| fingerprint(old) != fingerprint(record));
    if changed {
        let historical = state_dir(path)?
            .join("history")
            .join(format!("{}.json", fingerprint(record)));
        if previous.is_some() && historical.exists() {
            return Err("该凭证已经是历史版本；未覆盖较新的登录，请重新授权或同步原客户端".into());
        }
        if let Some(previous) = &previous {
            archive(path, &envelope(previous, None))?;
        }
        let next = envelope(record, previous.as_ref());
        // This is the first write after receiving a rotated pair. It is durable
        // before optional metadata, quota, primary-file or index operations.
        durable_write(&state_dir(path)?.join("credentials.json"), &next)?;
        archive(path, &next)?;
    }
    // Explicit login/import/metadata saves supersede an older runtime snapshot,
    // including reauthorization that happens to return the same token pair.
    write_runtime(path, record)?;
    before_primary()?;
    durable_write(path, record)?;
    if changed {
        prune_history(path);
    }
    Ok(())
}

/// Errors/quota snapshots have their own file; they cannot overwrite a token
/// generation or manufacture a successful validation timestamp.
pub(super) fn save_runtime(
    path: &Path,
    record: &Value,
    quota_verified: bool,
) -> Result<(), String> {
    let current = read_base(path)?;
    if fingerprint(&current) != fingerprint(record) {
        return Err("登录已更新；已丢弃旧查询结果".into());
    }
    write_runtime(path, record)?;
    if quota_verified {
        durable_write(
            &state_dir(path)?.join("last_verified.json"),
            &envelope(record, None),
        )?;
    }
    Ok(())
}

fn write_runtime(path: &Path, record: &Value) -> Result<(), String> {
    let state: serde_json::Map<_, _> = RUNTIME_FIELDS
        .iter()
        .filter_map(|key| record.get(key).map(|value| ((*key).into(), value.clone())))
        .collect();
    durable_write(
        &state_dir(path)?.join("runtime.json"),
        &json!({"schema_version":1,"fingerprint":fingerprint(record),"state":state}),
    )
}

/// Preserve the old gateway's last local copy before its auth-file cleanup.
/// This snapshot is never used as an automatic fallback after server rejection.
pub(super) fn preserve_legacy_gateway(path: &Path, credential: &Value) -> Result<(), String> {
    durable_write(&state_dir(path)?.join("legacy_gateway.json"), credential)
}

fn prune_history(path: &Path) {
    let Ok(directory) = state_dir(path) else {
        return;
    };
    let Ok(entries) = fs::read_dir(directory.join("history")) else {
        return;
    };
    let mut files: Vec<_> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort_by_key(|entry| entry.metadata().and_then(|meta| meta.modified()).ok());
    let excess = files.len().saturating_sub(HISTORY_LIMIT);
    for entry in files.into_iter().take(excess) {
        let _ = fs::remove_file(entry.path());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("cle-workbuddy-store-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn path(&self) -> PathBuf {
            self.0.join("fixture.json")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn account(token: &str) -> Value {
        json!({"id":"fixture","uid":"fixture-user","email":"fixture@example.invalid",
        "access_token":format!("access-{token}"),"refresh_token":format!("refresh-{token}"),"status":"normal",
        "tags":["keep"],"created_at":1,"last_used":2,"quota_raw":{"cached":true}})
    }
    #[test]
    fn interrupted_primary_commit_replays_the_new_pair_without_losing_labels() {
        let fixture = Fixture::new();
        let path = fixture.path();
        save(&path, &account("old")).unwrap();
        assert!(commit_with(&path, &account("new"), || Err(
            "simulate process interruption".into()
        ))
        .is_err());
        assert_eq!(read_json(&path).unwrap()["access_token"], "access-old");
        let recovered = load(&path).unwrap();
        assert_eq!(recovered["access_token"], "access-new");
        assert_eq!(recovered["refresh_token"], "refresh-new");
        assert_eq!(recovered["tags"], json!(["keep"]));
        assert_eq!(recovered["id"], "fixture");
    }
    #[test]
    fn runtime_failures_do_not_replace_history_or_last_verified_pair() {
        let fixture = Fixture::new();
        let path = fixture.path();
        let mut record = account("old");
        save(&path, &record).unwrap();
        save_runtime(&path, &record, true).unwrap();
        let directory = state_dir(&path).unwrap();
        let history = fs::read(directory.join("credentials.json")).unwrap();
        let good = fs::read(directory.join("last_verified.json")).unwrap();
        for _ in 0..3 {
            record["status"] = json!("login_required");
            record["quota_query_last_error"] = json!("fixture HTTP 401");
            save_runtime(&path, &record, false).unwrap();
        }
        assert_eq!(
            fs::read(directory.join("credentials.json")).unwrap(),
            history
        );
        assert_eq!(
            fs::read(directory.join("last_verified.json")).unwrap(),
            good
        );
        assert_eq!(load(&path).unwrap()["status"], "login_required");
    }
    #[test]
    fn a_new_login_ignores_old_errors_and_a_removed_account_is_not_resurrected() {
        let fixture = Fixture::new();
        let path = fixture.path();
        let mut old = account("old");
        save(&path, &old).unwrap();
        old["status"] = json!("login_required");
        save_runtime(&path, &old, false).unwrap();
        save(&path, &account("new")).unwrap();
        assert_eq!(load(&path).unwrap()["status"], "normal");
        fs::remove_file(&path).unwrap();
        assert!(load(&path).is_err());
    }
    #[test]
    fn conflicting_external_credentials_are_never_rolled_back_by_a_journal() {
        let fixture = Fixture::new();
        let path = fixture.path();
        save(&path, &account("old")).unwrap();
        save(&path, &account("new")).unwrap();
        durable_write(&path, &account("external")).unwrap();
        assert_eq!(load(&path).unwrap()["access_token"], "access-external");
    }
    #[test]
    fn corrupt_primary_is_read_from_journal_without_overwriting_evidence() {
        let fixture = Fixture::new();
        let path = fixture.path();
        save(&path, &account("new")).unwrap();
        fs::write(&path, "broken original").unwrap();
        assert_eq!(load(&path).unwrap()["access_token"], "access-new");
        assert_eq!(fs::read_to_string(&path).unwrap(), "broken original");
    }
    #[test]
    fn history_is_bounded_and_private_from_creation() {
        let fixture = Fixture::new();
        let path = fixture.path();
        for n in 0..12 {
            save(&path, &account(&n.to_string())).unwrap();
        }
        assert_eq!(
            fs::read_dir(state_dir(&path).unwrap().join("history"))
                .unwrap()
                .count(),
            HISTORY_LIMIT
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(state_dir(&path).unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
    }

    fn claude(token: &str) -> Value {
        json!({"id":"fixture","email":"fixture@example.invalid","auth_mode":"oauth",
            "account_uuid":"fixed-user","created_at":1,"last_used":2,"tags":["keep"],
            "claude_credentials_raw":{"claudeAiOauth":{"accessToken":format!("access-{token}"),"refreshToken":format!("refresh-{token}")}}})
    }

    #[test]
    fn claude_rotation_survives_interruption_and_quota_errors() {
        let fixture = Fixture::new();
        let path = fixture.path();
        save(&path, &claude("old")).unwrap();
        assert!(commit_with(&path, &claude("new"), || Err(
            "simulated interrupted quota window".into()
        ))
        .is_err());
        let mut recovered = load(&path).unwrap();
        assert_eq!(
            recovered
                .pointer("/claude_credentials_raw/claudeAiOauth/refreshToken")
                .unwrap(),
            "refresh-new"
        );
        let journal = fs::read(state_dir(&path).unwrap().join("credentials.json")).unwrap();
        recovered["quota_error"] = json!({"message":"fixture HTTP 401"});
        save_runtime(&path, &recovered, false).unwrap();
        assert_eq!(
            fs::read(state_dir(&path).unwrap().join("credentials.json")).unwrap(),
            journal
        );
        assert_eq!(load(&path).unwrap()["account_uuid"], "fixed-user");
        assert_eq!(load(&path).unwrap()["tags"], json!(["keep"]));
        let runtime = fs::read_to_string(state_dir(&path).unwrap().join("runtime.json")).unwrap();
        assert!(!runtime.contains("access-new") && !runtime.contains("refresh-new"));
    }

    #[test]
    fn delayed_writer_cannot_restore_an_archived_credential_pair() {
        let fixture = Fixture::new();
        let path = fixture.path();
        save(&path, &claude("old")).unwrap();
        save(&path, &claude("new")).unwrap();
        assert!(save(&path, &claude("old")).is_err());
        assert_eq!(
            load(&path)
                .unwrap()
                .pointer("/claude_credentials_raw/claudeAiOauth/accessToken")
                .unwrap(),
            "access-new"
        );
    }

    #[test]
    fn valid_json_with_a_missing_claude_token_uses_the_intact_journal() {
        let fixture = Fixture::new();
        let path = fixture.path();
        save(&path, &claude("saved")).unwrap();
        let mut incomplete = claude("saved");
        incomplete
            .as_object_mut()
            .unwrap()
            .remove("claude_credentials_raw");
        durable_write(&path, &incomplete).unwrap();
        assert_eq!(
            load(&path)
                .unwrap()
                .pointer("/claude_credentials_raw/claudeAiOauth/accessToken")
                .unwrap(),
            "access-saved"
        );
        assert!(read_json(&path)
            .unwrap()
            .get("claude_credentials_raw")
            .is_none());
    }

    #[test]
    fn a_tampered_journal_cannot_mix_credential_generations() {
        let fixture = Fixture::new();
        let path = fixture.path();
        save(&path, &claude("old")).unwrap();
        save(&path, &claude("new")).unwrap();
        let journal_path = state_dir(&path).unwrap().join("credentials.json");
        let mut journal = read_json(&journal_path).unwrap();
        journal["record"]["claude_credentials_raw"]["claudeAiOauth"]["accessToken"] =
            json!("corrupted");
        durable_write(&journal_path, &journal).unwrap();
        fs::write(&path, "broken").unwrap();
        assert_eq!(
            load(&path)
                .unwrap()
                .pointer("/claude_credentials_raw/claudeAiOauth/accessToken")
                .unwrap(),
            "access-new"
        );
    }

    #[test]
    fn old_quota_response_cannot_mark_a_new_login_as_expired() {
        let fixture = Fixture::new();
        let path = fixture.path();
        let mut old = claude("old");
        save(&path, &old).unwrap();
        save(&path, &claude("new")).unwrap();
        old["status"] = json!("login_required");
        assert!(save_runtime(&path, &old, false).is_err());
        assert!(load(&path).unwrap().get("status").is_none());
    }

    #[test]
    fn an_unwritable_journal_prevents_starting_a_rotation() {
        let fixture = Fixture::new();
        let path = fixture.path();
        save(&path, &account("old")).unwrap();
        let state = state_dir(&path).unwrap();
        fs::remove_dir_all(&state).unwrap();
        fs::write(&state, "fixture-blocked-directory").unwrap();
        assert!(prepare_refresh(&path, &account("old")).is_err());
        assert_eq!(read_json(&path).unwrap()["access_token"], "access-old");
    }

    #[test]
    fn abrupt_process_exit_after_journal_commit_preserves_rotated_pair() {
        const ENV: &str = "CLE_SYNTHETIC_CREDENTIAL_CRASH_DIR";
        if let Ok(directory) = std::env::var(ENV) {
            let directory = PathBuf::from(directory);
            assert!(directory.starts_with(std::env::temp_dir()));
            assert!(directory
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("cle-workbuddy-store-"));
            let _ = commit_with(
                &directory.join("fixture.json"),
                &claude("after-crash"),
                || std::process::exit(77),
            );
            panic!("expected exit at the injected failure point");
        }
        let fixture = Fixture::new();
        let path = fixture.path();
        save(&path, &claude("before-crash")).unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "credential_store::tests::abrupt_process_exit_after_journal_commit_preserves_rotated_pair", "--nocapture"])
            .env(ENV, &fixture.0).status().unwrap();
        assert_eq!(status.code(), Some(77));
        assert_eq!(
            read_json(&path)
                .unwrap()
                .pointer("/claude_credentials_raw/claudeAiOauth/refreshToken")
                .unwrap(),
            "refresh-before-crash"
        );
        assert_eq!(
            load(&path)
                .unwrap()
                .pointer("/claude_credentials_raw/claudeAiOauth/refreshToken")
                .unwrap(),
            "refresh-after-crash"
        );
    }
}
