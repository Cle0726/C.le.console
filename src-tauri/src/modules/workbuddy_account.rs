use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;
use tauri::Emitter;

use crate::models::workbuddy::{
    WorkbuddyAccount, WorkbuddyAccountIndex, WorkbuddyOAuthCompletePayload,
};
use crate::modules::{account, logger, workbuddy_oauth};

const ACCOUNTS_INDEX_FILE: &str = "workbuddy_accounts.json";
const ACCOUNTS_DIR: &str = "workbuddy_accounts";
const WORKBUDDY_QUOTA_ALERT_COOLDOWN_SECONDS: i64 = 10 * 60;
const WORKBUDDY_AUTH_FILE_NAME: &str = "workbuddy-desktop.info";
const WORKBUDDY_SECRET_EXTENSION_ID: &str = "tencent-cloud.coding-copilot";
const WORKBUDDY_SECRET_KEY: &str = "planning-genie.new.accessTokencn";
const LOGIN_REQUIRED_STATUS: &str = "login_required";

lazy_static::lazy_static! {
    static ref WORKBUDDY_ACCOUNT_INDEX_LOCK: Mutex<()> = Mutex::new(());
    static ref WORKBUDDY_QUOTA_ALERT_LAST_SENT: Mutex<HashMap<String, i64>> = Mutex::new(HashMap::new());
    static ref WORKBUDDY_REFRESH_LOCKS: Mutex<HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>> = Mutex::new(HashMap::new());
}

fn now_ts() -> i64 {
    chrono::Utc::now().timestamp()
}

fn is_login_required_error(message: &str) -> bool {
    let normalized = message.trim().to_ascii_lowercase();
    [
        "invalid_grant",
        "unauthorized",
        "authentication required",
        "login required",
        "session expired",
        "missing refresh token",
        "invalid refresh token",
        "refresh_token missing",
        "重新登录",
        "会话已过期",
        "http 401",
        "http=401",
        "code=401",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

fn get_data_dir() -> Result<PathBuf, String> {
    account::get_data_dir()
}

fn get_accounts_dir() -> Result<PathBuf, String> {
    let base = get_data_dir()?;
    let dir = base.join(ACCOUNTS_DIR);
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("创建 WorkBuddy 账号目录失败:{}", e))?;
    }
    Ok(dir)
}

fn get_accounts_index_path() -> Result<PathBuf, String> {
    Ok(get_data_dir()?.join(ACCOUNTS_INDEX_FILE))
}

pub fn accounts_index_path_string() -> Result<String, String> {
    Ok(get_accounts_index_path()?.to_string_lossy().to_string())
}

fn normalize_account_id(account_id: &str) -> Result<String, String> {
    let trimmed = account_id.trim();
    if trimmed.is_empty() {
        return Err("账号 ID 不能为空".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err("账号 ID 非法，包含路径字符".to_string());
    }
    let valid = trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.');
    if !valid {
        return Err("账号 ID 非法，仅允许字母/数字/._-".to_string());
    }
    Ok(trimmed.to_string())
}

fn resolve_account_file_path(account_id: &str) -> Result<PathBuf, String> {
    let normalized = normalize_account_id(account_id)?;
    Ok(get_accounts_dir()?.join(format!("{}.json", normalized)))
}

pub fn load_account(account_id: &str) -> Option<WorkbuddyAccount> {
    let account_path = resolve_account_file_path(account_id).ok()?;
    if !account_path.exists() {
        return None;
    }
    let content = fs::read_to_string(&account_path).ok()?;
    crate::modules::atomic_write::parse_json_with_auto_restore(&account_path, &content).ok()
}

fn save_account_file(account: &WorkbuddyAccount) -> Result<(), String> {
    let path = resolve_account_file_path(account.id.as_str())?;
    let content =
        serde_json::to_string_pretty(account).map_err(|e| format!("序列化账号失败:{}", e))?;
    crate::modules::atomic_write::write_string_atomic(&path, &content)
        .map_err(|e| format!("保存账号失败:{}", e))
}

fn delete_account_file(account_id: &str) -> Result<(), String> {
    let path = resolve_account_file_path(account_id)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| format!("删除账号文件失败:{}", e))?;
    }
    Ok(())
}

fn load_account_index() -> WorkbuddyAccountIndex {
    let path = match get_accounts_index_path() {
        Ok(p) => p,
        Err(_) => return WorkbuddyAccountIndex::new(),
    };
    if !path.exists() {
        return repair_account_index_from_details("索引文件不存在")
            .unwrap_or_else(WorkbuddyAccountIndex::new);
    }
    match fs::read_to_string(&path) {
        Ok(content) if content.trim().is_empty() => {
            repair_account_index_from_details("索引文件为空")
                .unwrap_or_else(WorkbuddyAccountIndex::new)
        }
        Ok(content) => match crate::modules::atomic_write::parse_json_with_auto_restore::<
            WorkbuddyAccountIndex,
        >(&path, &content)
        {
            Ok(index) if !index.accounts.is_empty() => index,
            Ok(_) => repair_account_index_from_details("索引账号列表为空")
                .unwrap_or_else(WorkbuddyAccountIndex::new),
            Err(err) => {
                logger::log_warn(&format!(
                    "[WorkBuddy Account] 账号索引解析失败，尝试按详情文件自动修复: path={}, error={}",
                    path.display(),
                    err
                ));
                repair_account_index_from_details("索引文件损坏")
                    .unwrap_or_else(WorkbuddyAccountIndex::new)
            }
        },
        Err(_) => WorkbuddyAccountIndex::new(),
    }
}

fn load_account_index_checked() -> Result<WorkbuddyAccountIndex, String> {
    let path = get_accounts_index_path()?;
    if !path.exists() {
        if let Some(index) = repair_account_index_from_details("索引文件不存在") {
            return Ok(index);
        }
        return Ok(WorkbuddyAccountIndex::new());
    }

    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(err) => {
            if let Some(index) = repair_account_index_from_details("索引文件读取失败") {
                return Ok(index);
            }
            return Err(format!("读取账号索引失败: {}", err));
        }
    };

    if content.trim().is_empty() {
        if let Some(index) = repair_account_index_from_details("索引文件为空") {
            return Ok(index);
        }
        return Ok(WorkbuddyAccountIndex::new());
    }

    match crate::modules::atomic_write::parse_json_with_auto_restore::<WorkbuddyAccountIndex>(
        &path, &content,
    ) {
        Ok(index) if !index.accounts.is_empty() => Ok(index),
        Ok(index) => {
            if let Some(repaired) = repair_account_index_from_details("索引账号列表为空") {
                return Ok(repaired);
            }
            Ok(index)
        }
        Err(err) => {
            if let Some(index) = repair_account_index_from_details("索引文件损坏") {
                return Ok(index);
            }
            Err(crate::error::file_corrupted_error(
                ACCOUNTS_INDEX_FILE,
                &path.to_string_lossy(),
                &err.to_string(),
            ))
        }
    }
}

fn save_account_index(index: &WorkbuddyAccountIndex) -> Result<(), String> {
    let path = get_accounts_index_path()?;
    let content =
        serde_json::to_string_pretty(index).map_err(|e| format!("序列化账号索引失败:{}", e))?;
    crate::modules::atomic_write::write_string_atomic(&path, &content)
        .map_err(|e| format!("写入账号索引失败:{}", e))
}

fn repair_account_index_from_details(reason: &str) -> Option<WorkbuddyAccountIndex> {
    let index_path = get_accounts_index_path().ok()?;
    let accounts_dir = get_accounts_dir().ok()?;
    let mut accounts = crate::modules::account_index_repair::load_accounts_from_details(
        &accounts_dir,
        |account_id| load_account(account_id),
    )
    .ok()?;

    if accounts.is_empty() {
        return None;
    }

    crate::modules::account_index_repair::sort_accounts_by_recency(
        &mut accounts,
        |account| account.last_used,
        |account| account.created_at,
        |account| account.id.as_str(),
    );

    let mut index = WorkbuddyAccountIndex::new();
    index.accounts = accounts.iter().map(|account| account.summary()).collect();

    let backup_path = crate::modules::account_index_repair::backup_existing_index(&index_path)
        .unwrap_or_else(|err| {
            logger::log_warn(&format!(
                "[WorkBuddy Account] 自动修复前备份索引失败，继续尝试重建: path={}, error={}",
                index_path.display(),
                err
            ));
            None
        });

    if let Err(err) = save_account_index(&index) {
        logger::log_warn(&format!(
            "[WorkBuddy Account] 自动修复索引保存失败，将以内存结果继续运行: reason={}, recovered_accounts={}, error={}",
            reason,
            index.accounts.len(),
            err
        ));
    }

    logger::log_warn(&format!(
        "[WorkBuddy Account] 检测到账号索引异常，已根据详情文件自动重建: reason={}, recovered_accounts={}, backup_path={}",
        reason,
        index.accounts.len(),
        backup_path
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "-".to_string())
    ));

    Some(index)
}

fn refresh_summary(index: &mut WorkbuddyAccountIndex, account: &WorkbuddyAccount) {
    if let Some(summary) = index.accounts.iter_mut().find(|item| item.id == account.id) {
        *summary = account.summary();
        return;
    }
    index.accounts.push(account.summary());
}

fn upsert_account_record(account: WorkbuddyAccount) -> Result<WorkbuddyAccount, String> {
    let _lock = WORKBUDDY_ACCOUNT_INDEX_LOCK
        .lock()
        .map_err(|_| "获取 WorkBuddy 账号锁失败".to_string())?;
    let mut index = load_account_index();
    save_account_file(&account)?;
    refresh_summary(&mut index, &account);
    save_account_index(&index)?;
    Ok(account)
}

fn normalize_non_empty(value: Option<&str>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn normalize_identity(value: Option<&str>) -> Option<String> {
    normalize_non_empty(value).map(|v| v.to_lowercase())
}

fn normalize_email_identity(value: Option<&str>) -> Option<String> {
    normalize_non_empty(value).and_then(|raw| {
        let lowered = raw.to_lowercase();
        if lowered.contains('@') {
            Some(lowered)
        } else {
            None
        }
    })
}

fn account_matches_payload_identity(
    existing_uid: Option<&String>,
    existing_email: Option<&String>,
    incoming_uid: Option<&String>,
    incoming_email: Option<&String>,
) -> bool {
    if let (Some(existing), Some(incoming)) = (existing_uid, incoming_uid) {
        if existing == incoming {
            return true;
        }
    }
    if let (Some(existing), Some(incoming)) = (existing_email, incoming_email) {
        if existing == incoming {
            if let (Some(eu), Some(iu)) = (existing_uid, incoming_uid) {
                if eu != iu {
                    return false;
                }
            }
            return true;
        }
    }
    false
}

fn accounts_are_duplicates(left: &WorkbuddyAccount, right: &WorkbuddyAccount) -> bool {
    let left_uid = normalize_identity(left.uid.as_deref());
    let right_uid = normalize_identity(right.uid.as_deref());
    let left_email = normalize_email_identity(Some(left.email.as_str()));
    let right_email = normalize_email_identity(Some(right.email.as_str()));

    let uid_conflict = matches!(
        (left_uid.as_ref(), right_uid.as_ref()),
        (Some(l), Some(r)) if l != r
    );
    let email_conflict = matches!(
        (left_email.as_ref(), right_email.as_ref()),
        (Some(l), Some(r)) if l != r
    );
    if uid_conflict || email_conflict {
        return false;
    }

    let uid_match = matches!(
        (left_uid.as_ref(), right_uid.as_ref()),
        (Some(l), Some(r)) if l == r
    );
    let email_match = matches!(
        (left_email.as_ref(), right_email.as_ref()),
        (Some(l), Some(r)) if l == r
    );

    uid_match || email_match
}

fn merge_string_list(
    primary: Option<Vec<String>>,
    secondary: Option<Vec<String>>,
) -> Option<Vec<String>> {
    let mut merged = Vec::new();
    let mut seen = HashSet::new();
    for source in [primary, secondary] {
        if let Some(values) = source {
            for value in values {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let key = trimmed.to_lowercase();
                if seen.insert(key) {
                    merged.push(trimmed.to_string());
                }
            }
        }
    }
    if merged.is_empty() {
        None
    } else {
        Some(merged)
    }
}

fn fill_if_none<T: Clone>(target: &mut Option<T>, source: &Option<T>) {
    if target.is_none() {
        *target = source.clone();
    }
}

fn merge_duplicate_account(primary: &mut WorkbuddyAccount, dup: &WorkbuddyAccount) {
    if primary.email.trim().is_empty() && !dup.email.trim().is_empty() {
        primary.email = dup.email.clone();
    }
    if primary.access_token.trim().is_empty() && !dup.access_token.trim().is_empty() {
        primary.access_token = dup.access_token.clone();
    }
    fill_if_none(&mut primary.uid, &dup.uid);
    fill_if_none(&mut primary.nickname, &dup.nickname);
    fill_if_none(&mut primary.enterprise_id, &dup.enterprise_id);
    fill_if_none(&mut primary.enterprise_name, &dup.enterprise_name);
    fill_if_none(&mut primary.refresh_token, &dup.refresh_token);
    fill_if_none(&mut primary.token_type, &dup.token_type);
    fill_if_none(&mut primary.expires_at, &dup.expires_at);
    fill_if_none(&mut primary.domain, &dup.domain);
    fill_if_none(&mut primary.plan_type, &dup.plan_type);
    fill_if_none(&mut primary.dosage_notify_code, &dup.dosage_notify_code);
    fill_if_none(&mut primary.payment_type, &dup.payment_type);
    fill_if_none(&mut primary.quota_raw, &dup.quota_raw);
    fill_if_none(&mut primary.auth_raw, &dup.auth_raw);
    fill_if_none(&mut primary.profile_raw, &dup.profile_raw);
    fill_if_none(&mut primary.usage_raw, &dup.usage_raw);
    fill_if_none(&mut primary.status, &dup.status);
    fill_if_none(
        &mut primary.quota_query_last_error,
        &dup.quota_query_last_error,
    );
    fill_if_none(
        &mut primary.quota_query_last_error_at,
        &dup.quota_query_last_error_at,
    );
    primary.tags = merge_string_list(primary.tags.clone(), dup.tags.clone());
    primary.created_at = primary.created_at.min(dup.created_at);
    primary.last_used = primary.last_used.max(dup.last_used);
}

fn choose_primary_account_index(group: &[usize], accounts: &[WorkbuddyAccount]) -> usize {
    group
        .iter()
        .copied()
        .max_by(|l, r| {
            accounts[*l]
                .last_used
                .cmp(&accounts[*r].last_used)
                .then_with(|| accounts[*r].created_at.cmp(&accounts[*l].created_at))
        })
        .unwrap_or(group[0])
}

fn normalize_account_index(index: &mut WorkbuddyAccountIndex) -> Vec<WorkbuddyAccount> {
    let mut loaded = Vec::new();
    let mut seen = HashSet::new();
    for summary in &index.accounts {
        if !seen.insert(summary.id.clone()) {
            continue;
        }
        if let Some(account) = load_account(&summary.id) {
            loaded.push(account);
        }
    }
    if loaded.len() <= 1 {
        index.accounts = loaded.iter().map(|a| a.summary()).collect();
        return loaded;
    }

    let mut parents: Vec<usize> = (0..loaded.len()).collect();
    fn find(parents: &mut [usize], idx: usize) -> usize {
        let p = parents[idx];
        if p == idx {
            return idx;
        }
        let root = find(parents, p);
        parents[idx] = root;
        root
    }
    fn union(parents: &mut [usize], l: usize, r: usize) {
        let lr = find(parents, l);
        let rr = find(parents, r);
        if lr != rr {
            parents[rr] = lr;
        }
    }

    let total = loaded.len();
    for l in 0..total {
        for r in (l + 1)..total {
            if accounts_are_duplicates(&loaded[l], &loaded[r]) {
                union(&mut parents, l, r);
            }
        }
    }

    let mut grouped: HashMap<usize, Vec<usize>> = HashMap::new();
    for idx in 0..total {
        let root = find(&mut parents, idx);
        grouped.entry(root).or_default().push(idx);
    }

    let mut processed = HashSet::new();
    let mut normalized = Vec::new();
    let mut removed_ids = Vec::new();
    for idx in 0..total {
        let root = find(&mut parents, idx);
        if !processed.insert(root) {
            continue;
        }
        let Some(group) = grouped.get(&root) else {
            continue;
        };
        if group.len() == 1 {
            normalized.push(loaded[group[0]].clone());
            continue;
        }
        let primary_idx = choose_primary_account_index(group, &loaded);
        let mut primary = loaded[primary_idx].clone();
        for member in group {
            if *member == primary_idx {
                continue;
            }
            merge_duplicate_account(&mut primary, &loaded[*member]);
            removed_ids.push(loaded[*member].id.clone());
        }
        normalized.push(primary);
    }

    if !removed_ids.is_empty() {
        for acc in &normalized {
            let _ = save_account_file(acc);
        }
        for id in &removed_ids {
            let _ = delete_account_file(id);
        }
        logger::log_warn(&format!(
            "[WorkBuddy Account] 检测到重复账号并已合并:removed_ids={}",
            removed_ids.join(",")
        ));
    }

    index.accounts = normalized.iter().map(|a| a.summary()).collect();
    normalized
}

pub fn list_accounts() -> Vec<WorkbuddyAccount> {
    let mut index = load_account_index();
    let had_index_accounts = !index.accounts.is_empty();
    let accounts = normalize_account_index(&mut index);
    if had_index_accounts && accounts.is_empty() {
        logger::log_warn(
            "[WorkBuddy Account] 账号索引中存在账号，但详情文件均无法读取，已跳过空索引写回",
        );
        return accounts;
    }
    if let Err(err) = save_account_index(&index) {
        logger::log_warn(&format!("[WorkBuddy Account] 保存账号索引失败:{}", err));
    }
    accounts
}

pub fn list_accounts_checked() -> Result<Vec<WorkbuddyAccount>, String> {
    let mut index = load_account_index_checked()?;
    let had_index_accounts = !index.accounts.is_empty();
    let accounts = normalize_account_index(&mut index);
    if had_index_accounts && accounts.is_empty() {
        return Err("WorkBuddy 账号索引中存在账号，但详情文件均无法读取；已保留前端缓存，请从账号备份或本地账号文件恢复。".to_string());
    }
    if let Err(err) = save_account_index(&index) {
        logger::log_warn(&format!("[WorkBuddy Account] 保存账号索引失败:{}", err));
    }
    Ok(accounts)
}

fn apply_payload(account: &mut WorkbuddyAccount, payload: WorkbuddyOAuthCompletePayload) {
    let incoming_email = payload.email.trim().to_string();
    if !incoming_email.is_empty() {
        account.email = incoming_email;
    }
    if payload.uid.is_some() {
        account.uid = payload.uid;
    }
    if payload.nickname.is_some() {
        account.nickname = payload.nickname;
    }
    if payload.enterprise_id.is_some() {
        account.enterprise_id = payload.enterprise_id;
    }
    if payload.enterprise_name.is_some() {
        account.enterprise_name = payload.enterprise_name;
    }
    account.access_token = payload.access_token;
    if payload
        .refresh_token
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        account.refresh_token = payload.refresh_token;
    }
    if payload.token_type.is_some() {
        account.token_type = payload.token_type;
    }
    if payload.expires_at.is_some() {
        account.expires_at = payload.expires_at;
    }
    if payload.domain.is_some() {
        account.domain = payload.domain;
    }
    if payload.plan_type.is_some() {
        account.plan_type = payload.plan_type;
    }
    if payload.dosage_notify_code.is_some() {
        account.dosage_notify_code = payload.dosage_notify_code;
    }
    if payload.dosage_notify_zh.is_some() {
        account.dosage_notify_zh = payload.dosage_notify_zh;
    }
    if payload.dosage_notify_en.is_some() {
        account.dosage_notify_en = payload.dosage_notify_en;
    }
    if payload.payment_type.is_some() {
        account.payment_type = payload.payment_type;
    }
    if payload.quota_raw.is_some() {
        account.quota_raw = payload.quota_raw;
    }
    if payload.auth_raw.is_some() {
        account.auth_raw = payload.auth_raw;
    }
    if payload.profile_raw.is_some() {
        account.profile_raw = payload.profile_raw;
    }
    if payload.usage_raw.is_some() {
        account.usage_raw = payload.usage_raw;
    }
    account.status = payload.status;
    account.status_reason = payload.status_reason;
    account.last_used = now_ts();
}

pub fn upsert_account(payload: WorkbuddyOAuthCompletePayload) -> Result<WorkbuddyAccount, String> {
    validate_payload_identity(&payload)?;
    let _lock = WORKBUDDY_ACCOUNT_INDEX_LOCK
        .lock()
        .map_err(|_| "获取 WorkBuddy 账号锁失败".to_string())?;
    let now = now_ts();
    let mut index = load_account_index();

    let incoming_uid = normalize_identity(payload.uid.as_deref());
    let incoming_email = normalize_email_identity(Some(payload.email.as_str()));

    let identity_seed = incoming_uid
        .clone()
        .or_else(|| incoming_email.clone())
        .unwrap_or_else(|| "workbuddy_user".to_string())
        .to_lowercase();
    let generated_id = format!("workbuddy_{:x}", md5::compute(identity_seed.as_bytes()));

    let account_id = index
        .accounts
        .iter()
        .filter_map(|item| load_account(&item.id))
        .find(|account| {
            let existing_uid = normalize_identity(account.uid.as_deref());
            let existing_email = normalize_email_identity(Some(account.email.as_str()));
            account_matches_payload_identity(
                existing_uid.as_ref(),
                existing_email.as_ref(),
                incoming_uid.as_ref(),
                incoming_email.as_ref(),
            )
        })
        .map(|a| a.id)
        .unwrap_or(generated_id);

    let existing = load_account(&account_id);
    let tags = existing.as_ref().and_then(|a| a.tags.clone());
    let created_at = existing.as_ref().map(|a| a.created_at).unwrap_or(now);

    let mut account = existing.unwrap_or(WorkbuddyAccount {
        id: account_id.clone(),
        email: payload.email.clone(),
        uid: payload.uid.clone(),
        nickname: payload.nickname.clone(),
        enterprise_id: payload.enterprise_id.clone(),
        enterprise_name: payload.enterprise_name.clone(),
        tags,
        access_token: payload.access_token.clone(),
        refresh_token: payload.refresh_token.clone(),
        token_type: payload.token_type.clone(),
        expires_at: payload.expires_at,
        domain: payload.domain.clone(),
        plan_type: payload.plan_type.clone(),
        dosage_notify_code: payload.dosage_notify_code.clone(),
        dosage_notify_zh: payload.dosage_notify_zh.clone(),
        dosage_notify_en: payload.dosage_notify_en.clone(),
        payment_type: payload.payment_type.clone(),
        quota_raw: payload.quota_raw.clone(),
        auth_raw: payload.auth_raw.clone(),
        profile_raw: payload.profile_raw.clone(),
        usage_raw: payload.usage_raw.clone(),
        status: payload.status.clone(),
        status_reason: payload.status_reason.clone(),
        quota_query_last_error: None,
        quota_query_last_error_at: None,
        token_refresh_last_error: None,
        token_refreshed_at: None,
        usage_updated_at: None,
        last_checkin_time: None,
        checkin_streak: None,
        checkin_rewards: None,
        created_at,
        last_used: now,
    });

    apply_payload(&mut account, payload);
    account.id = account_id;
    account.created_at = created_at;
    account.last_used = now;

    save_account_file(&account)?;
    refresh_summary(&mut index, &account);
    save_account_index(&index)?;

    logger::log_info(&format!(
        "WorkBuddy 账号已保存:id={}, email={}",
        account.id, account.email
    ));
    Ok(account)
}

fn apply_refresh_result(
    account: &mut WorkbuddyAccount,
    payload: WorkbuddyOAuthCompletePayload,
    diagnostics: &workbuddy_oauth::RefreshDiagnostics,
    refreshed_at: i64,
) {
    let tags = account.tags.clone();
    let created_at = account.created_at;
    apply_payload(account, payload);
    account.token_refresh_last_error = diagnostics.token_error.clone();
    if let Some(err) = &diagnostics.quota_error {
        if is_login_required_error(err) {
            account.status = Some(LOGIN_REQUIRED_STATUS.to_string());
            account.status_reason = Some("WorkBuddy 登录已失效，请重新登录".to_string());
        }
        account.quota_query_last_error = Some(err.clone());
        account.quota_query_last_error_at = Some(chrono::Utc::now().timestamp_millis());
    } else {
        account.quota_query_last_error = None;
        account.quota_query_last_error_at = None;
    }
    account.tags = tags;
    account.created_at = created_at;
    if diagnostics.quota_refreshed {
        account.usage_updated_at = Some(refreshed_at);
        account.status = Some("normal".to_string());
        account.status_reason = None;
    }
    if diagnostics.token_refreshed {
        account.token_refreshed_at = Some(refreshed_at);
    }
    account.last_used = refreshed_at;
}

async fn refresh_account_token_once(
    account_id: &str,
) -> Result<(WorkbuddyAccount, workbuddy_oauth::RefreshDiagnostics), String> {
    let started_at = Instant::now();
    let mut account = load_account(account_id).ok_or_else(|| "账号不存在".to_string())?;
    logger::log_info(&format!(
        "[WorkBuddy Refresh] 开始刷新账号:id={}, email={}",
        account.id, account.email
    ));

    let (payload, diagnostics) = workbuddy_oauth::refresh_payload_for_account(&account).await?;
    let latest =
        load_account(account_id).ok_or_else(|| "刷新期间账号已删除，未重新创建账号".to_string())?;
    if latest.access_token != account.access_token || latest.refresh_token != account.refresh_token
    {
        return Err("刷新期间登录凭证已被更新，已丢弃旧刷新结果；请重试".to_string());
    }
    account = latest;
    apply_refresh_result(&mut account, payload, &diagnostics, now_ts());

    let updated = account.clone();
    upsert_account_record(account)?;
    logger::log_info(&format!(
        "[WorkBuddy Refresh] 刷新结果:id={}, email={}, elapsed={}ms, token_refreshed={}, quota_refreshed={}",
        updated.id,
        updated.email,
        started_at.elapsed().as_millis(),
        diagnostics.token_refreshed,
        diagnostics.quota_refreshed
    ));
    Ok((updated, diagnostics))
}

pub(crate) async fn refresh_account_detailed(
    account_id: &str,
) -> Result<(WorkbuddyAccount, workbuddy_oauth::RefreshDiagnostics), String> {
    let refresh_lock = WORKBUDDY_REFRESH_LOCKS
        .lock()
        .map_err(|_| "获取 WorkBuddy 刷新锁失败".to_string())?
        .entry(account_id.to_string())
        .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
        .clone();
    let _refresh_guard = refresh_lock.lock().await;
    let result = refresh_account_token_once(account_id).await;
    if let Err(error) = &result {
        if let Some(mut account) = load_account(account_id) {
            account.quota_query_last_error = Some(error.clone());
            account.quota_query_last_error_at = Some(chrono::Utc::now().timestamp_millis());
            if is_login_required_error(error) {
                account.status = Some(LOGIN_REQUIRED_STATUS.to_string());
                account.status_reason = Some("WorkBuddy 登录已失效，请重新登录".to_string());
            }
            let _ = upsert_account_record(account);
        }
    }
    result
}

pub async fn refresh_account_token(account_id: &str) -> Result<WorkbuddyAccount, String> {
    let (account, diagnostics) = refresh_account_detailed(account_id).await?;
    if let Some(error) = diagnostics.error_message() {
        return Err(error);
    }
    Ok(account)
}

pub async fn refresh_all_tokens() -> Result<Vec<(String, Result<WorkbuddyAccount, String>)>, String>
{
    use futures::future::join_all;
    use std::sync::Arc;
    use tokio::sync::Semaphore;

    const MAX_CONCURRENT: usize = 5;
    let accounts = list_accounts_checked()?;
    let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT));
    let tasks: Vec<_> = accounts
        .into_iter()
        .map(|account| {
            let id = account.id;
            let semaphore = semaphore.clone();
            async move {
                let _permit = semaphore
                    .acquire_owned()
                    .await
                    .map_err(|e| format!("获取并发许可失败:{}", e))?;
                let result = refresh_account_token(&id).await;
                Ok::<(String, Result<WorkbuddyAccount, String>), String>((id, result))
            }
        })
        .collect();

    let mut results = Vec::with_capacity(tasks.len());
    for task in join_all(tasks).await {
        match task {
            Ok(item) => results.push(item),
            Err(err) => return Err(err),
        }
    }
    Ok(results)
}

pub fn remove_account(account_id: &str) -> Result<(), String> {
    let _lock = WORKBUDDY_ACCOUNT_INDEX_LOCK
        .lock()
        .map_err(|_| "获取 WorkBuddy 账号锁失败".to_string())?;
    let mut index = load_account_index();
    index.accounts.retain(|item| item.id != account_id);
    save_account_index(&index)?;
    delete_account_file(account_id)?;
    Ok(())
}

pub fn remove_accounts(account_ids: &[String]) -> Result<(), String> {
    for id in account_ids {
        remove_account(id)?;
    }
    Ok(())
}

pub fn update_account_tags(
    account_id: &str,
    tags: Vec<String>,
) -> Result<WorkbuddyAccount, String> {
    let mut account = load_account(account_id).ok_or_else(|| "账号不存在".to_string())?;
    account.tags = Some(tags);
    account.last_used = now_ts();
    let updated = account.clone();
    upsert_account_record(account)?;
    Ok(updated)
}

pub fn import_from_json(json_content: &str) -> Result<Vec<WorkbuddyAccount>, String> {
    if json_content.len() > 10 * 1024 * 1024 { return Err("账号备份超过 10MB，请分批导入".into()); }
    let value = serde_json::from_str::<Value>(json_content.trim_start_matches('\u{feff}'))
        .map_err(|_| "无法解析 WorkBuddy JSON 导入内容".to_string())?;
    import_from_json_value(value)
}

fn parse_import_records(value: Value) -> Result<Vec<(WorkbuddyOAuthCompletePayload, Option<WorkbuddyAccount>)>, String> {
    if let Some(format) = value.get("format").and_then(Value::as_str) {
        if format != "cle-workbuddy-accounts" { return Err("这不是 WorkBuddy 账号备份".into()); }
        if value.get("schemaVersion").and_then(Value::as_u64) != Some(1) { return Err("不支持此备份版本，请升级后导入".into()); }
    }
    let items = match value {
        Value::Array(items) => items,
        Value::Object(mut object) => {
            if object.contains_key("access_token")
                || object.contains_key("accessToken")
                || object.contains_key("token")
                || object.contains_key("auth")
            {
                vec![Value::Object(object)]
            } else {
                object
                    .remove("accounts")
                    .or_else(|| object.remove("items"))
                    .and_then(|value| value.as_array().cloned())
                    .ok_or_else(|| "无法解析 WorkBuddy 导入对象".to_string())?
            }
        }
        _ => return Err("WorkBuddy 导入 JSON 必须是对象或数组".to_string()),
    };
    if items.is_empty() {
        return Err("导入数组为空".to_string());
    }
    if items.len() > 1000 { return Err("单次最多导入 1000 个账号，请分批导入".into()); }
    // Validate the whole batch before writing its first record.
    items
        .into_iter()
        .enumerate()
        .map(|(index, raw)| {
            let payload = payload_from_import_value(raw.clone())
                .map_err(|error| format!("第 {} 条记录解析失败: {}", index + 1, error))?;
            validate_payload_identity(&payload)?;
            Ok((
                payload,
                serde_json::from_value::<WorkbuddyAccount>(raw).ok(),
            ))
        })
        .collect::<Result<Vec<_>, String>>()
}

fn import_from_json_value(value: Value) -> Result<Vec<WorkbuddyAccount>, String> {
    let parsed = parse_import_records(value)?;
    let mut imported = Vec::new();
    for (payload, snapshot) in parsed {
        let mut account = upsert_account(payload)?;
        if let Some(snapshot) = snapshot {
            account.tags = merge_string_list(account.tags, snapshot.tags);
            account.created_at = account.created_at.min(snapshot.created_at);
            // Quota fields above came from this snapshot; keep their matching timestamp.
            account.usage_updated_at = snapshot.usage_updated_at.or(account.usage_updated_at);
            if snapshot.last_checkin_time >= account.last_checkin_time {
                account.last_checkin_time = snapshot.last_checkin_time.or(account.last_checkin_time);
                account.checkin_streak = snapshot.checkin_streak.or(account.checkin_streak);
                account.checkin_rewards = snapshot.checkin_rewards.or(account.checkin_rewards);
            }
            account.last_used = account.last_used.max(snapshot.last_used);
            account.token_refreshed_at = snapshot.token_refreshed_at.or(account.token_refreshed_at);
            account.token_refresh_last_error = snapshot.token_refresh_last_error;
            account.quota_query_last_error = snapshot.quota_query_last_error;
            account.quota_query_last_error_at = snapshot.quota_query_last_error_at;
            account = upsert_account_record(account)?;
        }
        imported.push(account);
    }
    Ok(imported)
}

fn validate_payload_identity(payload: &WorkbuddyOAuthCompletePayload) -> Result<(), String> {
    if payload.access_token.trim().is_empty() {
        return Err("缺少有效 access_token".to_string());
    }
    if normalize_identity(payload.uid.as_deref()).is_none()
        && normalize_email_identity(Some(&payload.email)).is_none()
    {
        return Err("无法确认 WorkBuddy 账号身份（缺少 uid 或邮箱），未覆盖已保存账号。请重新授权或从客户端导入。".to_string());
    }
    Ok(())
}

fn payload_from_import_value(raw: Value) -> Result<WorkbuddyOAuthCompletePayload, String> {
    let obj = raw
        .as_object()
        .ok_or_else(|| "导入条目必须是对象".to_string())?;

    if obj.contains_key("auth") {
        let raw_token = parse_local_access_token(&raw)
            .ok_or_else(|| "本地凭证缺少 access token".to_string())?;
        let (uid, token) = extract_local_workbuddy_token_parts(&raw_token)
            .ok_or_else(|| "本地 access token 无效".to_string())?;
        return Ok(build_local_import_payload(token, Some(raw), uid));
    }

    let access_token = obj
        .get("access_token")
        .or_else(|| obj.get("accessToken"))
        .or_else(|| obj.get("token"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if access_token.is_empty() {
        return Err("缺少 access_token".to_string());
    }

    let email = obj
        .get("email")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let uid = obj
        .get("uid")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let nickname = obj
        .get("nickname")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let enterprise_id = obj
        .get("enterprise_id")
        .or_else(|| obj.get("enterpriseId"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let enterprise_name = obj
        .get("enterprise_name")
        .or_else(|| obj.get("enterpriseName"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let refresh_token = obj
        .get("refresh_token")
        .or_else(|| obj.get("refreshToken"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let domain = obj
        .get("domain")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let expires_at = workbuddy_oauth::token_expires_at(&raw, &access_token, now_ts());
    Ok(WorkbuddyOAuthCompletePayload {
        email,
        uid,
        nickname,
        enterprise_id,
        enterprise_name,
        access_token,
        refresh_token,
        token_type: obj.get("token_type").or_else(|| obj.get("tokenType")).and_then(Value::as_str).map(str::to_string).or_else(|| Some("Bearer".to_string())),
        expires_at,
        domain,
        plan_type: obj
            .get("plan_type")
            .and_then(Value::as_str)
            .map(str::to_string),
        dosage_notify_code: obj
            .get("dosage_notify_code")
            .and_then(Value::as_str)
            .map(str::to_string),
        dosage_notify_zh: obj
            .get("dosage_notify_zh")
            .and_then(Value::as_str)
            .map(str::to_string),
        dosage_notify_en: obj
            .get("dosage_notify_en")
            .and_then(Value::as_str)
            .map(str::to_string),
        payment_type: obj
            .get("payment_type")
            .and_then(Value::as_str)
            .map(str::to_string),
        quota_raw: obj
            .get("quota_raw")
            .filter(|value| !value.is_null())
            .cloned(),
        auth_raw: obj.get("auth_raw").cloned(),
        profile_raw: obj.get("profile_raw").cloned(),
        usage_raw: obj.get("usage_raw").cloned(),
        status: obj.get("status").and_then(Value::as_str).map(str::to_string).or_else(|| Some("normal".into())),
        status_reason: obj.get("status_reason").and_then(Value::as_str).map(str::to_string),
    })
}

pub fn export_accounts(account_ids: &[String]) -> Result<String, String> {
    if account_ids.is_empty() {
        return Err("请选择需要导出的 WorkBuddy 账号".to_string());
    }
    let accounts: Vec<WorkbuddyAccount> = account_ids
        .iter()
        .map(|id| load_account(id).ok_or_else(|| format!("导出失败，账号不存在或无法读取：{}", id)))
        .collect::<Result<_, _>>()?;
    serde_json::to_string_pretty(&serde_json::json!({
        "format": "cle-workbuddy-accounts", "schemaVersion": 1,
        "exportedAt": chrono::Utc::now().to_rfc3339(), "accounts": accounts,
    })).map_err(|e| format!("导出失败:{}", e))
}

pub fn export_backup_file(path: &Path, account_ids: &[String]) -> Result<(), String> {
    if !path.is_absolute() || !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("json")) {
        return Err("请选择 JSON 备份文件的完整路径".into());
    }
    super::atomic_write::write_private_string_atomic(path, &export_accounts(account_ids)?)
}

pub fn get_default_workbuddy_data_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".workbuddy").join("app"))
}

fn get_workbuddy_shared_auth_dir() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    #[cfg(target_os = "macos")]
    {
        return Some(
            home.join("Library")
                .join("Application Support")
                .join("CodeBuddyExtension")
                .join("Data")
                .join("Public")
                .join("auth"),
        );
    }

    #[cfg(target_os = "windows")]
    {
        return Some(
            home.join("AppData")
                .join("Local")
                .join("CodeBuddyExtension")
                .join("Data")
                .join("Public")
                .join("auth"),
        );
    }

    #[cfg(target_os = "linux")]
    {
        return Some(
            home.join(".local")
                .join("share")
                .join("CodeBuddyExtension")
                .join("Data")
                .join("Public")
                .join("auth"),
        );
    }

    #[allow(unreachable_code)]
    None
}

pub fn get_default_workbuddy_auth_file_path() -> Option<PathBuf> {
    get_workbuddy_shared_auth_dir().map(|dir| dir.join(WORKBUDDY_AUTH_FILE_NAME))
}

fn get_workbuddy_vscode_data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        return dirs::home_dir().map(|home| home.join("Library/Application Support/WorkBuddy"));
    }
    #[cfg(target_os = "windows")]
    {
        return dirs::data_dir().map(|dir| dir.join("WorkBuddy"));
    }
    #[cfg(target_os = "linux")]
    {
        return dirs::config_dir().map(|dir| dir.join("WorkBuddy"));
    }
    #[allow(unreachable_code)]
    None
}

fn get_workbuddy_state_db_path() -> Option<PathBuf> {
    get_workbuddy_vscode_data_dir()
        .map(|dir| dir.join("User").join("globalStorage").join("state.vscdb"))
}

fn workbuddy_logout_marker_path(auth_file: &Path) -> PathBuf {
    PathBuf::from(format!("{}.logged-out", auth_file.to_string_lossy()))
}

fn parse_local_access_token(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Array(arr) => arr.iter().find_map(parse_local_access_token),
        Value::Object(obj) => {
            let direct = obj
                .get("token")
                .or_else(|| obj.get("access_token"))
                .or_else(|| obj.get("accessToken"))
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            if let Some(token) = direct {
                return Some(token);
            }

            let auth_token = obj
                .get("auth")
                .and_then(|v| v.as_object())
                .and_then(|auth| {
                    auth.get("accessToken")
                        .or_else(|| auth.get("access_token"))
                        .and_then(|v| v.as_str())
                })
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            if let Some(token) = auth_token {
                return Some(token);
            }

            let encoded = obj
                .get("session")
                .or_else(|| obj.get("data"))
                .and_then(parse_local_access_token);
            if encoded.is_some() {
                return encoded;
            }

            None
        }
        _ => None,
    }
}

fn normalize_local_workbuddy_token(token: &str) -> Option<String> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some((_, suffix)) = trimmed.split_once('+') {
        let suffix = suffix.trim();
        if !suffix.is_empty() {
            return Some(suffix.to_string());
        }
    }
    Some(trimmed.to_string())
}

fn extract_local_workbuddy_token_parts(token: &str) -> Option<(Option<String>, String)> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some((prefix, suffix)) = trimmed.split_once('+') {
        let uid = prefix.trim();
        let token_value = suffix.trim();
        if token_value.is_empty() {
            return None;
        }
        let uid_opt = if uid.is_empty() {
            None
        } else {
            Some(uid.to_string())
        };
        return Some((uid_opt, token_value.to_string()));
    }
    Some((None, trimmed.to_string()))
}

fn json_object_string_field(obj: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        let value = obj
            .get(*key)
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty());
        if let Some(found) = value {
            return Some(found.to_string());
        }
    }
    None
}

fn json_object_i64_field(obj: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<i64> {
    for key in keys {
        let Some(raw) = obj.get(*key) else {
            continue;
        };
        if let Some(v) = raw.as_i64() {
            return Some(v);
        }
        if let Some(v) = raw.as_u64() {
            if let Ok(parsed) = i64::try_from(v) {
                return Some(parsed);
            }
        }
        if let Some(v) = raw.as_str() {
            if let Ok(parsed) = v.trim().parse::<i64>() {
                return Some(parsed);
            }
        }
    }
    None
}

fn build_local_import_payload(
    access_token: String,
    parsed_json: Option<Value>,
    uid_from_token: Option<String>,
) -> WorkbuddyOAuthCompletePayload {
    let root_obj = parsed_json.as_ref().and_then(|v| v.as_object());
    let account_obj = root_obj.and_then(|obj| obj.get("account").and_then(|v| v.as_object()));
    let auth_obj = root_obj.and_then(|obj| obj.get("auth").and_then(|v| v.as_object()));

    let uid = root_obj
        .and_then(|obj| json_object_string_field(obj, &["uid"]))
        .or_else(|| account_obj.and_then(|obj| json_object_string_field(obj, &["uid", "id"])))
        .or(uid_from_token);

    let nickname = root_obj
        .and_then(|obj| json_object_string_field(obj, &["nickname", "name"]))
        .or_else(|| {
            account_obj.and_then(|obj| json_object_string_field(obj, &["nickname", "label"]))
        });

    let email = root_obj
        .and_then(|obj| json_object_string_field(obj, &["email"]))
        .or_else(|| account_obj.and_then(|obj| json_object_string_field(obj, &["email"])))
        .or_else(|| auth_obj.and_then(|obj| json_object_string_field(obj, &["email"])))
        .or_else(|| nickname.clone())
        .or_else(|| uid.clone())
        .unwrap_or_else(|| "unknown".to_string());

    let enterprise_id = root_obj
        .and_then(|obj| json_object_string_field(obj, &["enterpriseId", "enterprise_id"]))
        .or_else(|| {
            account_obj
                .and_then(|obj| json_object_string_field(obj, &["enterpriseId", "enterprise_id"]))
        });
    let enterprise_name = root_obj
        .and_then(|obj| json_object_string_field(obj, &["enterpriseName", "enterprise_name"]))
        .or_else(|| {
            account_obj.and_then(|obj| {
                json_object_string_field(obj, &["enterpriseName", "enterprise_name"])
            })
        });

    let refresh_token = root_obj
        .and_then(|obj| json_object_string_field(obj, &["refreshToken", "refresh_token"]))
        .or_else(|| {
            auth_obj
                .and_then(|obj| json_object_string_field(obj, &["refreshToken", "refresh_token"]))
        });
    let token_type = root_obj
        .and_then(|obj| json_object_string_field(obj, &["tokenType", "token_type"]))
        .or_else(|| {
            auth_obj.and_then(|obj| json_object_string_field(obj, &["tokenType", "token_type"]))
        })
        .or_else(|| Some("Bearer".to_string()));
    let domain = root_obj
        .and_then(|obj| json_object_string_field(obj, &["domain"]))
        .or_else(|| auth_obj.and_then(|obj| json_object_string_field(obj, &["domain"])));
    let expires_at = root_obj
        .and_then(|obj| json_object_i64_field(obj, &["expiresAt", "expires_at"]))
        .or_else(|| {
            auth_obj.and_then(|obj| json_object_i64_field(obj, &["expiresAt", "expires_at"]))
        })
        .filter(|value| *value > 0)
        .map(|value| {
            if value > 10_000_000_000 {
                value / 1000
            } else {
                value
            }
        })
        .or_else(|| workbuddy_oauth::token_expires_at(&Value::Null, &access_token, now_ts()));

    WorkbuddyOAuthCompletePayload {
        email,
        uid,
        nickname,
        enterprise_id,
        enterprise_name,
        access_token,
        refresh_token,
        token_type,
        expires_at,
        domain,
        plan_type: None,
        dosage_notify_code: None,
        dosage_notify_zh: None,
        dosage_notify_en: None,
        payment_type: None,
        quota_raw: None,
        auth_raw: parsed_json.clone(),
        profile_raw: account_obj.map(|obj| Value::Object(obj.clone())),
        usage_raw: None,
        status: Some("normal".to_string()),
        status_reason: None,
    }
}

fn build_default_auth_account_value(account: &WorkbuddyAccount) -> Value {
    let mut account_obj = account
        .profile_raw
        .as_ref()
        .and_then(|value| value.as_object())
        .cloned()
        .or_else(|| {
            account
                .auth_raw
                .as_ref()
                .and_then(|value| value.as_object())
                .and_then(|obj| obj.get("account").and_then(|value| value.as_object()))
                .cloned()
        })
        .unwrap_or_else(serde_json::Map::new);

    if let Some(uid) = account
        .uid
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        account_obj.insert("uid".to_string(), Value::String(uid.to_string()));
    }
    if let Some(nickname) = account
        .nickname
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        account_obj.insert("nickname".to_string(), Value::String(nickname.to_string()));
    }

    account_obj
        .entry("type".to_string())
        .or_insert_with(|| Value::String("personal".to_string()));
    account_obj
        .entry("accountType".to_string())
        .or_insert_with(|| Value::String(String::new()));
    account_obj
        .entry("idp".to_string())
        .or_insert_with(|| Value::String(String::new()));
    account_obj
        .entry("oneidAccountId".to_string())
        .or_insert_with(|| Value::String(String::new()));
    account_obj
        .entry("areaInfoComplete".to_string())
        .or_insert_with(|| Value::Bool(false));
    account_obj
        .entry("isCurrentOneIdEnterprise".to_string())
        .or_insert_with(|| Value::Bool(false));
    account_obj
        .entry("isFirstLogin".to_string())
        .or_insert_with(|| Value::Bool(false));
    account_obj.insert("lastLogin".to_string(), Value::Bool(true));
    account_obj.insert("pluginEnabled".to_string(), Value::Bool(true));
    account_obj
        .entry("deployStatus".to_string())
        .or_insert_with(|| {
            serde_json::json!({
                "statusCode": 0,
                "statusMsg": "",
                "detailMsg": ""
            })
        });
    account_obj.entry("sso".to_string()).or_insert_with(|| {
        serde_json::json!({
            "domain": "",
            "domainModifiedTimes": 0
        })
    });

    Value::Object(account_obj)
}

fn seconds_until_ms(timestamp_ms: i64, now_ms: i64) -> i64 {
    if timestamp_ms > now_ms {
        (timestamp_ms - now_ms) / 1000
    } else {
        0
    }
}

fn build_default_auth_value(account: &WorkbuddyAccount) -> Value {
    let root_obj = account
        .auth_raw
        .as_ref()
        .and_then(|value| value.as_object());
    let raw_auth_obj = root_obj.and_then(|obj| obj.get("auth").and_then(|value| value.as_object()));
    let mut auth_obj = raw_auth_obj
        .cloned()
        .or_else(|| {
            root_obj
                .filter(|obj| obj.contains_key("accessToken") || obj.contains_key("refreshToken"))
                .cloned()
        })
        .unwrap_or_else(serde_json::Map::new);

    let now_ms = chrono::Utc::now().timestamp_millis();
    let refresh_token = account.refresh_token.as_deref().unwrap_or("");
    let token_type = account.token_type.as_deref().unwrap_or("Bearer");
    let domain = account.domain.as_deref().unwrap_or("");

    auth_obj.insert(
        "accessToken".to_string(),
        Value::String(account.access_token.clone()),
    );
    auth_obj.insert(
        "refreshToken".to_string(),
        Value::String(refresh_token.to_string()),
    );
    auth_obj.insert(
        "tokenType".to_string(),
        Value::String(token_type.to_string()),
    );
    auth_obj.insert("domain".to_string(), Value::String(domain.to_string()));
    auth_obj.insert(
        "lastRefreshTime".to_string(),
        Value::Number(serde_json::Number::from(now_ms)),
    );

    // Account scheduling uses seconds; the desktop SDK stores absolute times in milliseconds.
    if let Some(expires_at) = account.expires_at.filter(|value| *value > 0).map(|value| {
        if value > 10_000_000_000 {
            value
        } else {
            value.saturating_mul(1000)
        }
    }) {
        auth_obj.insert(
            "expiresAt".to_string(),
            Value::Number(serde_json::Number::from(expires_at)),
        );
        auth_obj.insert(
            "expiresIn".to_string(),
            Value::Number(serde_json::Number::from(seconds_until_ms(
                expires_at, now_ms,
            ))),
        );

        let refresh_expires_at = raw_auth_obj
            .and_then(|obj| json_object_i64_field(obj, &["refreshExpiresAt", "refresh_expires_at"]))
            .filter(|value| *value > 0)
            .map(|value| {
                if value > 10_000_000_000 {
                    value
                } else {
                    value.saturating_mul(1000)
                }
            })
            .unwrap_or(expires_at);
        auth_obj.insert(
            "refreshExpiresAt".to_string(),
            Value::Number(serde_json::Number::from(refresh_expires_at)),
        );
        auth_obj.insert(
            "refreshExpiresIn".to_string(),
            Value::Number(serde_json::Number::from(seconds_until_ms(
                refresh_expires_at,
                now_ms,
            ))),
        );
    } else {
        auth_obj
            .entry("expiresIn".to_string())
            .or_insert_with(|| Value::Number(serde_json::Number::from(0)));
        auth_obj
            .entry("refreshExpiresIn".to_string())
            .or_insert_with(|| Value::Number(serde_json::Number::from(0)));
    }

    auth_obj
        .entry("scope".to_string())
        .or_insert_with(|| Value::String("openid profile offline_access email".to_string()));

    Value::Object(auth_obj)
}

pub(crate) fn build_runtime_auth_session(account: &WorkbuddyAccount) -> Value {
    let account_value = build_default_auth_account_value(account);
    serde_json::json!({
        "account": account_value.clone(),
        "auth": build_default_auth_value(account),
        "accounts": [account_value],
    })
}

fn payload_from_local_secret(secret: &str) -> Result<WorkbuddyOAuthCompletePayload, String> {
    let parsed_json = serde_json::from_str::<Value>(&secret).ok();
    let token_candidate = parsed_json
        .as_ref()
        .and_then(parse_local_access_token)
        .or_else(|| {
            let raw = secret.trim();
            if raw.is_empty() {
                None
            } else {
                Some(raw.to_string())
            }
        });

    let Some(raw_token) = token_candidate else {
        return Err("本地 WorkBuddy 登录信息解析失败: 未找到 access token".to_string());
    };

    let Some((uid_from_token, normalized_token)) = extract_local_workbuddy_token_parts(&raw_token)
    else {
        return Err("本地 WorkBuddy 登录信息解析失败: access token 无效".to_string());
    };
    let Some(access_token) = normalize_local_workbuddy_token(&normalized_token) else {
        return Err("本地 WorkBuddy 登录信息解析失败: access token 为空".to_string());
    };

    Ok(build_local_import_payload(
        access_token,
        parsed_json,
        uid_from_token,
    ))
}

pub fn import_payload_from_local() -> Result<Option<WorkbuddyOAuthCompletePayload>, String> {
    let mut errors = Vec::new();

    // WorkBuddy 5.x stores a shared native auth file on all desktop platforms.
    if let Some(auth_file) = get_default_workbuddy_auth_file_path() {
        if auth_file.exists() && !workbuddy_logout_marker_path(&auth_file).exists() {
            match fs::read_to_string(&auth_file)
                .map_err(|e| format!("读取本机 WorkBuddy 登录信息失败: {}", e))
                .and_then(|secret| payload_from_local_secret(&secret))
            {
                Ok(payload) => return Ok(Some(payload)),
                Err(error) => errors.push(format!("原生认证文件：{}", error)),
            }
        }
    }

    // Older/current distribution variants use VS Code SecretStorage instead.
    // Keep this fallback for macOS and for installations migrated between versions.
    if let (Some(data_root), Some(state_db)) = (
        get_workbuddy_vscode_data_dir(),
        get_workbuddy_state_db_path(),
    ) {
        if state_db.exists() {
            match crate::modules::vscode_inject::read_workbuddy_secret_storage_value(
                WORKBUDDY_SECRET_EXTENSION_ID,
                WORKBUDDY_SECRET_KEY,
                Some(data_root.to_string_lossy().as_ref()),
            ) {
                Ok(Some(secret)) => match payload_from_local_secret(&secret) {
                    Ok(payload) => return Ok(Some(payload)),
                    Err(error) => errors.push(format!("SecretStorage：{}", error)),
                },
                Ok(None) => {}
                Err(error) => errors.push(format!("SecretStorage：{}", error)),
            }
        }
    }

    if errors.is_empty() {
        Ok(None)
    } else {
        Err(format!(
            "无法读取本机 WorkBuddy 登录：{}",
            errors.join("；")
        ))
    }
}

pub fn write_account_to_default_client(account: &WorkbuddyAccount) -> Result<(), String> {
    let auth_file = get_default_workbuddy_auth_file_path()
        .ok_or_else(|| "无法定位默认 WorkBuddy 登录信息路径".to_string())?;
    let had_native_auth = auth_file.exists();
    let marker_path = workbuddy_logout_marker_path(&auth_file);
    if marker_path.exists() {
        fs::remove_file(&marker_path).map_err(|e| format!("清理 WorkBuddy 登出标记失败: {}", e))?;
    }

    let session = build_runtime_auth_session(account);
    let content =
        serde_json::to_string_pretty(&session).map_err(|e| format!("序列化登录信息失败: {}", e))?;
    crate::modules::atomic_write::write_string_atomic(&auth_file, &content)
        .map_err(|e| format!("写入 WorkBuddy 登录信息失败: {}", e))?;

    let written = fs::read_to_string(&auth_file)
        .map_err(|e| format!("校验 WorkBuddy 登录信息失败: {}", e))?;
    let written_json: Value = serde_json::from_str(&written)
        .map_err(|e| format!("校验 WorkBuddy 登录信息 JSON 失败: {}", e))?;
    let written_token = written_json
        .get("auth")
        .and_then(|auth| auth.get("accessToken"))
        .and_then(|value| value.as_str());
    if written_token != Some(account.access_token.as_str()) {
        return Err(format!(
            "校验 WorkBuddy 登录信息失败，未写入目标账号: {}",
            auth_file.display()
        ));
    }

    // If this installation is backed by VS Code SecretStorage, update that authoritative
    // store as well. Do not create a second profile/database for native-auth installations.
    if let Some(state_db) = get_workbuddy_state_db_path().filter(|path| path.exists()) {
        let secret_key = format!(
            r#"secret://{{"extensionId":"{}","key":"{}"}}"#,
            WORKBUDDY_SECRET_EXTENSION_ID, WORKBUDDY_SECRET_KEY
        );
        if let Err(error) = crate::modules::vscode_inject::inject_secret_to_state_db_for_workbuddy(
            &state_db,
            &secret_key,
            &content,
        ) {
            if !had_native_auth {
                return Err(format!("写入 WorkBuddy SecretStorage 失败: {}", error));
            }
            logger::log_warn(&format!(
                "[WorkBuddy Account] 原生认证已写入，但兼容 SecretStorage 更新失败: {}",
                error
            ));
        }
    }

    Ok(())
}

pub fn sync_account_to_default_client(account_id: &str) -> Result<(), String> {
    let account =
        load_account(account_id).ok_or_else(|| format!("WorkBuddy 账号不存在: {}", account_id))?;
    write_account_to_default_client(&account)
}

pub(crate) fn verify_default_client_credentials(account: &WorkbuddyAccount) -> Result<(), String> {
    let imported = import_payload_from_local()?
        .ok_or_else(|| "WorkBuddy 启动后登录凭证缺失或已被客户端登出".to_string())?;
    let same_identity = match (&account.uid, &imported.uid) {
        (Some(expected), Some(actual)) => expected == actual,
        _ => account.access_token == imported.access_token,
    };
    if !same_identity || account.enterprise_id != imported.enterprise_id {
        return Err("WorkBuddy 启动后凭证与目标账号不一致，切换未确认".to_string());
    }
    Ok(())
}

pub(crate) fn resolve_current_account_id(accounts: &[WorkbuddyAccount]) -> Option<String> {
    match import_payload_from_local() {
        Ok(Some(payload)) => {
            let incoming_uid = normalize_identity(payload.uid.as_deref());
            let incoming_email = normalize_email_identity(Some(payload.email.as_str()));

            if let Some(account_id) = accounts
                .iter()
                .find(|account| {
                    let existing_uid = normalize_identity(account.uid.as_deref());
                    let existing_email = normalize_email_identity(Some(account.email.as_str()));
                    account_matches_payload_identity(
                        existing_uid.as_ref(),
                        existing_email.as_ref(),
                        incoming_uid.as_ref(),
                        incoming_email.as_ref(),
                    )
                })
                .map(|account| account.id.clone())
            {
                return Some(account_id);
            }
        }
        Ok(None) => {}
        Err(err) => logger::log_warn(&format!(
            "[WorkBuddy Account] 读取默认客户端当前账号失败，回退内部当前账号: {}",
            err
        )),
    }

    crate::modules::provider_current_state::resolve_existing_current_account_id(
        "workbuddy",
        accounts.iter().map(|account| account.id.as_str()),
    )
}

pub fn run_quota_alert_if_needed() -> Result<(), String> {
    let config = crate::modules::config::get_user_config();
    if !config.workbuddy_quota_alert_enabled {
        return Ok(());
    }
    let threshold = config.workbuddy_quota_alert_threshold;
    if threshold <= 0 {
        return Ok(());
    }

    let accounts = list_accounts();
    let now = now_ts();
    let mut last_sent = WORKBUDDY_QUOTA_ALERT_LAST_SENT
        .lock()
        .map_err(|_| "获取预警锁失败".to_string())?;

    for account in &accounts {
        let cooldown_key = account.id.clone();
        if let Some(last) = last_sent.get(&cooldown_key) {
            if now - last < WORKBUDDY_QUOTA_ALERT_COOLDOWN_SECONDS {
                continue;
            }
        }

        let should_alert = match account.dosage_notify_code.as_deref() {
            Some(code) if code != "USAGE_NORMAL" && !code.is_empty() => true,
            _ => false,
        };

        if should_alert {
            last_sent.insert(cooldown_key, now);
            if let Some(app) = crate::get_app_handle() {
                let msg = account
                    .dosage_notify_zh
                    .as_deref()
                    .or(account.dosage_notify_en.as_deref())
                    .unwrap_or("配额即将耗尽");

                let _ = app.emit(
                    "quota:alert",
                    serde_json::json!({
                        "platform": "workbuddy",
                        "accountId": account.id,
                        "email": account.email,
                        "message": msg,
                    }),
                );
            }
        }
    }

    Ok(())
}

/// 将 WorkBuddy 账号同步到 CodeBuddy CN
pub fn sync_accounts_to_codebuddy_cn() -> Result<usize, String> {
    use crate::models::codebuddy::CodebuddyOAuthCompletePayload;
    use crate::modules::codebuddy_cn_account;

    let workbuddy_accounts = list_accounts();
    if workbuddy_accounts.is_empty() {
        return Ok(0);
    }

    let mut synced_count = 0;
    for wb_account in workbuddy_accounts {
        // 将 WorkBuddy 账号转换为 CodeBuddy CN payload
        let payload = CodebuddyOAuthCompletePayload {
            email: wb_account.email.clone(),
            uid: wb_account.uid.clone(),
            nickname: wb_account.nickname.clone(),
            enterprise_id: wb_account.enterprise_id.clone(),
            enterprise_name: wb_account.enterprise_name.clone(),
            access_token: wb_account.access_token.clone(),
            refresh_token: wb_account.refresh_token.clone(),
            token_type: wb_account.token_type.clone(),
            expires_at: wb_account.expires_at,
            domain: wb_account.domain.clone(),
            plan_type: wb_account.plan_type.clone(),
            dosage_notify_code: wb_account.dosage_notify_code.clone(),
            dosage_notify_zh: wb_account.dosage_notify_zh.clone(),
            dosage_notify_en: wb_account.dosage_notify_en.clone(),
            payment_type: wb_account.payment_type.clone(),
            quota_raw: wb_account.quota_raw.clone(),
            auth_raw: wb_account.auth_raw.clone(),
            profile_raw: wb_account.profile_raw.clone(),
            usage_raw: wb_account.usage_raw.clone(),
            status: wb_account.status.clone(),
            status_reason: wb_account.status_reason.clone(),
            last_checkin_time: None,
            checkin_streak: 0,
            checkin_rewards: None,
        };

        // 使用 CodeBuddy CN 的 upsert 函数保存账号
        match codebuddy_cn_account::upsert_account(payload) {
            Ok(_) => {
                synced_count += 1;
                logger::log_info(&format!(
                    "[WorkBuddy -> CodeBuddy CN] 同步账号成功: email={}",
                    wb_account.email
                ));
            }
            Err(e) => {
                logger::log_warn(&format!(
                    "[WorkBuddy -> CodeBuddy CN] 同步账号失败: email={}, error={}",
                    wb_account.email, e
                ));
            }
        }
    }

    Ok(synced_count)
}

#[cfg(test)]
mod management_tests {
    use super::*;
    use serde_json::json;

    fn sample(uid: &str) -> WorkbuddyAccount {
        serde_json::from_value(json!({
            "id": format!("fixture-{}", uid), "uid": uid, "email": format!("{}@example.invalid", uid),
            "access_token": "fixture-access-token", "refresh_token": "fixture-refresh-token",
            "created_at": 1, "last_used": 2, "usage_updated_at": 5, "tags": ["keep"],
            "quota_raw": {"userResource": {"data": {"Accounts": [1]}}},
            "usage_raw": {"data": {"Accounts": [1]}}
        })).unwrap()
    }

    #[test]
    fn token_only_import_does_not_erase_refresh_token_or_identity() {
        let mut account = sample("uid-a");
        let payload =
            payload_from_import_value(json!({"uid": "uid-a", "access_token": "updated-token"}))
                .unwrap();
        apply_payload(&mut account, payload);
        assert_eq!(account.access_token, "updated-token");
        assert_eq!(
            account.refresh_token.as_deref(),
            Some("fixture-refresh-token")
        );
        assert_eq!(account.uid.as_deref(), Some("uid-a"));
        assert_eq!(account.tags, Some(vec!["keep".to_string()]));
        assert!(account.quota_raw.is_some());
    }

    #[test]
    fn quota_failure_does_not_advance_cached_usage_timestamp() {
        let mut account = sample("uid-a");
        let payload =
            payload_from_import_value(json!({"uid": "uid-a", "access_token": "updated-token"}))
                .unwrap();
        let diagnostics = workbuddy_oauth::RefreshDiagnostics {
            token_refreshed: true,
            quota_error: Some("请求失败 (http=403): 请求不合法".to_string()),
            ..Default::default()
        };
        apply_refresh_result(&mut account, payload, &diagnostics, 999);
        assert_eq!(account.usage_updated_at, Some(5));
        assert_eq!(account.token_refreshed_at, Some(999));
        assert!(account.quota_query_last_error.is_some());
        assert_ne!(account.status.as_deref(), Some("login_required"));
        assert!(diagnostics.error_message().is_some());
    }

    #[test]
    fn successful_quota_refresh_clears_stale_error() {
        let mut account = sample("uid-a");
        account.quota_query_last_error = Some("old".to_string());
        account.status = Some("login_required".to_string());
        let payload =
            payload_from_import_value(json!({"uid": "uid-a", "access_token": "updated-token"}))
                .unwrap();
        let diagnostics = workbuddy_oauth::RefreshDiagnostics {
            token_refreshed: true,
            quota_refreshed: true,
            ..Default::default()
        };
        apply_refresh_result(&mut account, payload, &diagnostics, 999);
        assert_eq!(account.usage_updated_at, Some(999));
        assert_eq!(account.status.as_deref(), Some("normal"));
        assert!(account.quota_query_last_error.is_none());
    }

    #[test]
    fn invalid_request_403_is_not_proof_that_login_expired() {
        assert!(!is_login_required_error("请求失败 (http=403): 请求不合法"));
        assert!(is_login_required_error("请求失败 (http=401): Unauthorized"));
        assert!(is_login_required_error("刷新失败 (code=401)"));
    }

    #[test]
    fn unknown_identity_is_not_merged_into_placeholder_account() {
        let unknown = payload_from_import_value(
            json!({"access_token": "fixture-access-token", "email": "unknown"}),
        )
        .unwrap();
        assert!(validate_payload_identity(&unknown).is_err());
        let identified = payload_from_import_value(
            json!({"access_token": "fixture-access-token", "uid": "uid-a"}),
        )
        .unwrap();
        assert!(validate_payload_identity(&identified).is_ok());
        assert!(!accounts_are_duplicates(&sample("uid-a"), &sample("uid-b")));
    }

    #[test]
    fn exported_record_and_native_session_can_be_parsed_without_losing_credentials() {
        let account = sample("uid-a");
        let exported = payload_from_import_value(serde_json::to_value(&account).unwrap()).unwrap();
        assert_eq!(exported.refresh_token, account.refresh_token);
        assert_eq!(exported.quota_raw, account.quota_raw);
        let session = build_runtime_auth_session(&account);
        let native = payload_from_import_value(session).unwrap();
        assert_eq!(native.uid, account.uid);
        assert_eq!(native.access_token, account.access_token);
        assert_eq!(native.refresh_token, account.refresh_token);
    }

    #[test]
    fn versioned_backup_and_legacy_array_are_supported_but_foreign_files_are_not() {
        let mut account = sample("uid-a");
        account.status = Some("login_required".into());
        account.status_reason = Some("fixture expired".into());
        account.last_checkin_time = Some(10);
        account.checkin_streak = Some(3);
        account.checkin_rewards = Some(json!({"points": 10}));
        let records = json!([account]);
        let parsed = parse_import_records(json!({"format":"cle-workbuddy-accounts", "schemaVersion":1, "accounts":records})).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].0.status.as_deref(), Some("login_required"));
        assert_eq!(parsed[0].0.status_reason.as_deref(), Some("fixture expired"));
        assert_eq!(parsed[0].1.as_ref().unwrap().checkin_streak, Some(3));
        assert!(parse_import_records(records.clone()).is_ok());
        assert!(parse_import_records(json!({"format":"another-provider", "schemaVersion":1, "accounts":records})).is_err());
        assert!(parse_import_records(json!({"format":"cle-workbuddy-accounts", "schemaVersion":2, "accounts":records})).is_err());
        assert!(parse_import_records(json!([{"id":"../../escape", "email":"unknown", "access_token":"fixture", "created_at":1, "last_used":2}])).is_err());
    }

    #[test]
    fn native_session_expiry_roundtrip_keeps_desktop_milliseconds_and_account_seconds() {
        let mut account = sample("uid-a");
        let expiry = now_ts() + 3600;
        account.expires_at = Some(expiry);
        let session = build_runtime_auth_session(&account);
        assert_eq!(session["auth"]["expiresAt"].as_i64(), Some(expiry * 1000));
        assert!(session["auth"]["expiresIn"].as_i64().unwrap() >= 3598);
        let native = payload_from_import_value(session).unwrap();
        assert_eq!(native.expires_at, Some(expiry));

        // Older exported records may still have millisecond expiry values.
        account.expires_at = Some(expiry * 1000);
        let session = build_runtime_auth_session(&account);
        assert_eq!(session["auth"]["expiresAt"].as_i64(), Some(expiry * 1000));
        assert_eq!(
            payload_from_import_value(session).unwrap().expires_at,
            Some(expiry)
        );
    }

    #[test]
    #[ignore = "isolated storage verification; explicitly supply WORKBUDDY_STORAGE_SMOKE_DIR and CLE_CONSOLE_DATA_DIR"]
    fn isolated_workbuddy_import_export_roundtrip() {
        let expected = PathBuf::from(
            std::env::var("WORKBUDDY_STORAGE_SMOKE_DIR").expect("isolated directory required"),
        );
        let actual = get_data_dir().unwrap();
        assert_eq!(actual, expected);
        assert!(actual
            .to_string_lossy()
            .contains("workbuddy-management-repair"));
        assert!(
            list_accounts_checked().unwrap().is_empty(),
            "start with a clean isolated directory"
        );
        let accounts = import_from_json(
            &serde_json::to_string(&vec![sample("uid-a"), sample("uid-b")]).unwrap(),
        )
        .unwrap();
        assert_eq!(accounts.len(), 2);
        assert_ne!(accounts[0].id, accounts[1].id);
        let ids = accounts
            .iter()
            .map(|account| account.id.clone())
            .collect::<Vec<_>>();
        let exported = export_accounts(&ids).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&exported).unwrap()["schemaVersion"], 1);
        let backup_path = actual.join("private-backup.json");
        export_backup_file(&backup_path, &ids).unwrap();
        assert!(backup_path.is_file());
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&backup_path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(!actual.join("private-backup.json.bak").exists());
        let restored = import_from_json(&exported).unwrap();
        assert_eq!(restored.len(), 2);
        for account in &restored {
            assert_eq!(
                account.refresh_token.as_deref(),
                Some("fixture-refresh-token")
            );
            assert_eq!(account.usage_updated_at, Some(5));
            assert_eq!(account.tags, Some(vec!["keep".to_string()]));
        }
        import_from_json(r#"{"uid":"uid-a","access_token":"new-fixture-access-token"}"#).unwrap();
        assert_eq!(
            load_account(&ids[0]).unwrap().refresh_token.as_deref(),
            Some("fixture-refresh-token")
        );
        let invalid_batch = json!([{"uid":"uid-c", "access_token":"fixture"}, {"email":"unknown", "access_token":"fixture"}]);
        assert!(import_from_json(&invalid_batch.to_string()).is_err());
        assert_eq!(list_accounts_checked().unwrap().len(), 2);
        assert!(export_accounts(&["missing-id".to_string()]).is_err());
        let record = json!({"id":"../../outside", "uid":"uid-c", "email":"c@example.com", "access_token":"fixture", "created_at":1, "last_used":2,
            "tags":["roundtrip"], "status":"login_required", "status_reason":"fixture expired", "last_checkin_time":123, "checkin_streak":4, "checkin_rewards":{"points":9}});
        let full = import_from_json(&record.to_string()).unwrap().remove(0);
        assert!(full.id.starts_with("workbuddy_"));
        assert!(!full.id.contains('/'));
        assert_eq!(full.status.as_deref(), Some("login_required"));
        assert_eq!(full.checkin_streak, Some(4));
        assert_eq!(full.checkin_rewards, Some(json!({"points":9})));
        let roundtrip = import_from_json(&export_accounts(&[full.id.clone()]).unwrap()).unwrap().remove(0);
        assert_eq!(roundtrip.last_checkin_time, full.last_checkin_time);
        assert_eq!(roundtrip.status_reason, full.status_reason);
    }
}

pub fn update_checkin_info(
    account_id: &str,
    last_checkin_time: Option<i64>,
    streak: i32,
    rewards: Option<serde_json::Value>,
) -> Result<WorkbuddyAccount, String> {
    let mut account = load_account(account_id).ok_or_else(|| "账号不存在".to_string())?;

    if let Some(time) = last_checkin_time {
        account.last_checkin_time = Some(time);
    }
    account.checkin_streak = Some(streak);
    account.checkin_rewards = rewards;

    account.last_used = now_ts();
    let updated = account.clone();
    save_account_file(&account)?;

    logger::log_info(&format!(
        "[WorkBuddy Checkin] 签到信息已更新: account_id={}, streak={}",
        updated.id, streak
    ));

    Ok(updated)
}
