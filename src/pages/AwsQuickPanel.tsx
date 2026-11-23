import { useCallback, useEffect, useRef, useState } from 'react';
import { confirm } from '@tauri-apps/plugin-dialog';
import { BadgeCheck, Building2, LogIn, RefreshCw, Trash2 } from 'lucide-react';
import { openOAuthUrl } from '../utils/openOAuthUrl';
import { multiModelApiService as api, type AwsQuickAccount } from '../services/multiModelApiService';
import type { MultiModelApiState } from '../types/multiModelApi';

type Quota = { plan?: string; windows?: { name: string; display?: string; resetsAt?: string }[]; error?: string; expired?: boolean };

// AWS Quick (Amazon Quick) accounts via the bundled magpie-AWS-Quick-bridge
// sidecar. Each account signs in in the browser and joins the pool behind the
// shared C.le key as aws-quick/<mode>.
export function AwsQuickPanel({ onChanged }: { onChanged: (state: MultiModelApiState) => void }) {
  const [accounts, setAccounts] = useState<AwsQuickAccount[]>([]);
  const [quotas, setQuotas] = useState<Record<string, Quota>>({});
  const [busy, setBusy] = useState(false);
  const [login, setLogin] = useState<{ id: string; url: string } | null>(null);
  const [region, setRegion] = useState('us-east-1');
  const [message, setMessage] = useState<{ tone: 'info' | 'error' | 'success'; text: string } | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    const list = await api.awsQuickAccounts();
    if (mounted.current) setAccounts(list);
    return list;
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load().catch(() => {});
    return () => { mounted.current = false; };
  }, [load]);

  const sync = useCallback(async () => {
    const state = await api.syncAwsQuickAccounts();
    onChanged(state);
    await load();
  }, [load, onChanged]);

  // Polls the sign-in started in the browser until it ends.
  useEffect(() => {
    if (!login) return;
    let stopped = false;
    const tick = async () => {
      while (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (stopped) return;
        try {
          const status = await api.awsQuickLoginStatus(login.id);
          if (status.status === 'success') {
            setLogin(null);
            await sync();
            setMessage({ tone: 'success', text: `${status.accountId || 'AWS Quick 账号'} 已登录，并接入 API 账号池（aws-quick/smart 等）。` });
            return;
          }
          if (status.status === 'error') {
            setLogin(null);
            setMessage({ tone: 'error', text: status.message || '登录失败' });
            return;
          }
        } catch (error) {
          setLogin(null);
          setMessage({ tone: 'error', text: String(error) });
          return;
        }
      }
    };
    void tick();
    return () => { stopped = true; };
  }, [login, sync]);

  const start = async (enterprise: boolean) => {
    setMessage(null);
    try {
      const started = await api.awsQuickLoginStart(enterprise, enterprise ? region : '');
      setLogin({ id: started.loginId, url: started.url });
      await openOAuthUrl(started.url);
    } catch (error) {
      setMessage({ tone: 'error', text: String(error) });
    }
  };

  const cancel = async () => {
    if (login) await api.awsQuickLoginCancel(login.id).catch(() => {});
    setLogin(null);
  };

  const run = async (task: () => Promise<string | void>) => {
    setBusy(true); setMessage(null);
    try {
      const text = await task();
      if (text) setMessage({ tone: 'success', text });
    } catch (error) {
      setMessage({ tone: 'error', text: String(error) });
    } finally { setBusy(false); }
  };

  const refreshQuota = (id: string) => run(async () => {
    const quota = await api.awsQuickQuota(id) as Quota;
    setQuotas((prev) => ({ ...prev, [id]: quota }));
  });

  return <section className="mm-doubao-web-panel">
    <div className="mm-inline-actions">
      <button type="button" className="btn btn-primary" disabled={busy || !!login} onClick={() => void start(false)}><LogIn />添加个人账号（浏览器登录）</button>
      <input className="mm-aws-quick-region" value={region} onChange={(event) => setRegion(event.target.value)} placeholder="区域，如 us-east-1" aria-label="企业账号区域" />
      <button type="button" className="btn btn-secondary" disabled={busy || !!login} onClick={() => void start(true)}><Building2 />添加企业账号（IAM Identity Center）</button>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void run(async () => { await sync(); return '已同步到 API 账号池。'; })}><RefreshCw />接入 API / 同步</button>
    </div>
    {login && <div className="mm-api-message info"><LogIn /><span>请在浏览器里登录 Amazon Quick，看到 “Login complete” 即可回到这里。浏览器没有打开？<a href="#" onClick={(event) => { event.preventDefault(); void openOAuthUrl(login.url); }}>再次打开</a> · <a href="#" onClick={(event) => { event.preventDefault(); void cancel(); }}>取消</a>。提示 “Your session has expired” 时，请用无痕窗口打开登录地址或清除 signin.aws 的 Cookie。</span></div>}
    {message && <div className={`mm-api-message ${message.tone}`}><BadgeCheck /><span>{message.text}</span></div>}
    <div className="mm-doubao-web-list">
      {accounts.map((account) => {
        const quota = quotas[account.id];
        return <article key={account.id} className="mm-doubao-web-row">
          <div>
            <strong>{account.accountId || account.id}{account.enterprise ? ' · 企业' : ''}</strong>
            <small>{quota ? (quota.error ? quota.error : `${quota.plan ?? ''} ${(quota.windows ?? []).map((w) => `${w.name}: ${w.display ?? ''}`).join(' · ')}`) : `本机网关 127.0.0.1:${account.port || '—'}`}</small>
          </div>
          <em className={account.running ? 'online' : ''}>{account.running ? '运行中' : '未运行'}</em>
          <div className="mm-inline-actions">
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void refreshQuota(account.id)}><RefreshCw />查看额度</button>
            <button type="button" className="btn btn-secondary danger" disabled={busy} onClick={() => void run(async () => {
              if (!await confirm(`删除 AWS Quick 账号“${account.accountId || account.id}”？本机保存的登录状态会一起清除。`, { title: '删除 AWS Quick 账号', kind: 'warning' })) return;
              onChanged(await api.awsQuickRemove(account.id));
              await load();
              return '账号已删除。';
            })}><Trash2 />删除</button>
          </div>
        </article>;
      })}
      {!accounts.length && <p className="mm-quota-hint">还没有 AWS Quick 账号。点“添加个人账号”在浏览器登录 Amazon Quick；企业账号先填区域再登录。可以重复登录添加多个账号。</p>}
    </div>
  </section>;
}
