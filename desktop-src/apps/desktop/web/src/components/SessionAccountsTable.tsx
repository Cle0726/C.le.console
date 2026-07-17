import { useMemo, useState } from 'react';
import type { ClaudeSessionAccount, ClaudeSessionRuntimeState } from '@desktop/contracts';
import { maskSessionKey } from '@/lib/desktopApi';

interface SessionAccountsTableProps {
  accounts: ClaudeSessionAccount[];
  runtimeStates: ClaudeSessionRuntimeState[];
  defaultDailyLimit: number;
  onChange(accounts: ClaudeSessionAccount[]): void;
}

function createId() {
  return `acct_${Math.random().toString(36).slice(2, 10)}`;
}

export function SessionAccountsTable({ accounts, runtimeStates, defaultDailyLimit, onChange }: SessionAccountsTableProps) {
  const [bulkInput, setBulkInput] = useState('');
  const runtimeMap = useMemo(
    () => new Map(runtimeStates.map((item) => [item.accountId, item])),
    [runtimeStates],
  );

  function patchAccount(id: string, patch: Partial<ClaudeSessionAccount>) {
    onChange(accounts.map((account) => (account.id === id ? { ...account, ...patch } : account)));
  }

  function removeAccount(id: string) {
    onChange(accounts.filter((account) => account.id !== id));
  }

  function importAccounts() {
    const values = bulkInput
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean);

    if (!values.length) {
      return;
    }

    const existing = new Set(accounts.map((account) => account.sessionKey));
    const next = [...accounts];
    for (const sessionKey of values) {
      if (existing.has(sessionKey)) {
        continue;
      }
      existing.add(sessionKey);
      next.push({
        id: createId(),
        label: `Claude Web ${next.length + 1}`,
        sessionKey,
        proxyUrl: '',
        enabled: true,
        dailyLimit: defaultDailyLimit,
      });
    }
    onChange(next);
    setBulkInput('');
  }

  function clearInvalidAccounts() {
    onChange(accounts.filter((account) => runtimeMap.get(account.id)?.status !== 'invalid'));
  }

  return (
    <section className="panel">
      <div className="panel-header split">
        <div>
          <h2>账号池管理</h2>
          <p className="subtle">支持 sessionKey 批量导入、独立代理 URL、单条启停、删除与失效清理，并展示最近失败类型与 transport。</p>
        </div>
        <button className="ghost" onClick={clearInvalidAccounts}>清空所有失效账号</button>
      </div>

      <div className="bulk-import-box">
        <textarea
          rows={4}
          placeholder="按逗号或换行粘贴多个 sessionKey"
          value={bulkInput}
          onChange={(event) => setBulkInput(event.target.value)}
        />
        <button className="primary" onClick={importAccounts}>批量导入</button>
      </div>

      <div className="table-shell">
        <table>
          <thead>
            <tr>
              <th>SessionKey</th>
              <th>标签</th>
              <th>状态</th>
              <th>运行态</th>
              <th>Proxy URL</th>
              <th>单账号限额</th>
              <th>启用</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {accounts.length ? (
              accounts.map((account) => {
                const runtime = runtimeMap.get(account.id);
                return (
                  <tr key={account.id}>
                    <td>
                      <code>{maskSessionKey(account.sessionKey)}</code>
                    </td>
                    <td>
                      <input
                        value={account.label}
                        onChange={(event) => patchAccount(account.id, { label: event.target.value })}
                      />
                    </td>
                    <td>
                      <span className={`badge ${runtime?.status ?? 'healthy'}`}>{runtime?.status ?? 'healthy'}</span>
                    </td>
                    <td>
                      <div className="runtime-stack">
                        <strong>今日调用 {runtime?.todayCalls ?? 0}</strong>
                        {runtime?.cooldownUntil ? <small>冷却至 {new Date(runtime.cooldownUntil).toLocaleString()}</small> : null}
                        {runtime?.retryAfterUntil ? <small>Retry-After 至 {new Date(runtime.retryAfterUntil).toLocaleString()}</small> : null}
                        {runtime?.lastFailureKind ? <small>失败类型：{runtime.lastFailureKind}</small> : null}
                        {runtime?.lastStatusCode ? <small>状态码：{runtime.lastStatusCode}</small> : null}
                        {runtime?.lastTransport ? <small>Transport：{runtime.lastTransport}</small> : null}
                        {runtime?.consecutiveFailures ? <small>连续失败：{runtime.consecutiveFailures}</small> : null}
                        {runtime?.lastSuccessAt ? <small>最近成功：{new Date(runtime.lastSuccessAt).toLocaleString()}</small> : null}
                        {runtime?.lastError ? <small className="error-text">{runtime.lastError}</small> : null}
                      </div>
                    </td>
                    <td>
                      <input
                        placeholder="http:// 或 socks5://"
                        value={account.proxyUrl ?? ''}
                        onChange={(event) => patchAccount(account.id, { proxyUrl: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={1}
                        value={account.dailyLimit ?? defaultDailyLimit}
                        onChange={(event) => patchAccount(account.id, { dailyLimit: Number.parseInt(event.target.value, 10) || defaultDailyLimit })}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={account.enabled}
                        onChange={(event) => patchAccount(account.id, { enabled: event.target.checked })}
                      />
                    </td>
                    <td>
                      <button className="danger-text" onClick={() => removeAccount(account.id)}>删除</button>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={8} className="empty-cell">还没有导入任何 sessionKey。</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
