import { useCallback, useEffect, useRef, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { listen } from '@tauri-apps/api/event';
import { confirm } from '@tauri-apps/plugin-dialog';
import { CalendarCheck, Globe, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { multiModelApiService as api } from '../services/multiModelApiService';
import type { MultiModelApiState } from '../types/multiModelApi';

export const EXTENSION_PROVIDERS = [
  { id: 'qoder', label: 'Qoder / QoderWork' }, { id: 'trae', label: 'Trae' },
  { id: 'raccoon', label: '小浣熊' }, { id: 'catpaw', label: 'CatPaw' },
  { id: 'autoclaw', label: 'AutoClaw 国内' }, { id: 'autoclaw-intl', label: 'AutoClaw 国际' },
  { id: 'accio', label: 'Accio' }, { id: 'loomy', label: 'Loomy' },
] as const;
interface Account { id: string; name: string; provider: string; enabled: boolean; edition?: string; available?: boolean }
interface CheckinAccount { id: string; name: string; checkedInToday: boolean }
interface CheckinGroup { id: string; label: string; accounts: CheckinAccount[]; doneCount: number; totalCount: number }
interface AutoState { enabled: boolean; time: string; providers: string[]; providerOptions: { id: string; label: string }[]; running: boolean; lastResult?: unknown; lastFiredToday?: boolean }
interface Center { daily: { providers: CheckinGroup[]; todayDone: number; todayEligible: number }; auto: AutoState; history: unknown[] }
interface UsageResult { id: string; usage?: unknown; error?: string; at?: number }

// Display precise upstream fields, never invent totals or turn unknown quota into zero.
function usageLabel(usage: unknown): string {
  if (!usage || typeof usage !== 'object') return '上游未返回额度';
  const data = usage as Record<string, unknown>;
  const labels: Record<string, string> = { available: '可用', totalLeft: '剩余', remaining: '剩余', balance: '余额', credits: '积分', points: '积分', planLeft: '套餐剩余', rewardLeft: '奖励剩余', usageTotal: '总额度', used: '已用', total: '总额度' };
  const lines = Object.entries(data).filter(([key, value]) => key in labels && (typeof value === 'number' || typeof value === 'string')).map(([key, value]) => `${labels[key]} ${value}`);
  if (Array.isArray(data.wallets)) for (const wallet of data.wallets) {
    if (wallet && typeof wallet === 'object' && typeof wallet.balance === 'number') lines.push(`${wallet.displayName ?? '余额'} ${wallet.balance}${wallet.unit ?? data.unit ?? ''}`);
  }
  return lines.length ? lines.join(' · ') : '上游未返回明确的额度数值';
}

export function ExtensionProviderPage({ initialProvider = 'qoder', onSynced }: { initialProvider?: string; onSynced: (state: MultiModelApiState) => void }) {
  const [provider, setProvider] = useState(initialProvider);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [center, setCenter] = useState<Center | null>(null);
  const [auto, setAuto] = useState<AutoState | null>(null);
  const [usage, setUsage] = useState<UsageResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [name, setName] = useState('');
  const [edition, setEdition] = useState('cn');
  const [credentials, setCredentials] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [task, setTask] = useState<{ state: string; authUrl: string; hosted: boolean; provider: string; startedAt: number } | null>(null);
  const taskRef = useRef(task);
  taskRef.current = task;
  const [callback, setCallback] = useState('');
  const mounted = useRef(true);
  const reload = useCallback(async () => {
    const [list, checkins, snapshot] = await Promise.all([
      api.extensionRequest<{ accounts: Account[] }>('GET', '/api/accounts'),
      api.extensionRequest<Center>('GET', '/api/checkin-center'),
      api.extensionRequest<{ results: UsageResult[] }>('GET', '/api/accounts/usage/snapshot'),
    ]);
    if (!mounted.current) return;
    setAccounts(list.accounts); setCenter(checkins); setAuto(checkins.auto); setUsage(snapshot.results ?? []);
  }, []);
  useEffect(() => {
    mounted.current = true;
    void reload().catch(error => { if (mounted.current) setMessage(String(error)); });
    const unlisten = listen<{ state: string; error?: string; cancelled?: boolean }>('extension-login:status', ({ payload }) => {
      if (taskRef.current?.state !== payload.state) return;
      if (payload.cancelled) { setTask(null); setMessage('授权窗口已关闭，登录已取消。可以重新添加账号。'); }
      else if (payload.error) setMessage(`授权回调失败：${payload.error}。可重新打开授权页或重新开始登录。`);
    });
    return () => {
      mounted.current = false;
      void unlisten.then(stop => stop()).catch(() => {});
      if (taskRef.current) void api.finishExtensionLogin(taskRef.current.state, true).catch(() => {});
    };
  }, [reload]);
  useEffect(() => { setProvider(initialProvider); }, [initialProvider]);
  const action = async (work: () => Promise<unknown>, success: string) => {
    if (busy) return;
    setBusy(true); setMessage('');
    try { await work(); await reload(); if (mounted.current) setMessage(success); }
    catch (error) { if (mounted.current) setMessage(String(error)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const sync = async () => { const state = await api.syncExtensionAccounts(); onSynced(state); };
  useEffect(() => {
    if (!task) return;
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (Date.now() - task.startedAt > 5 * 60_000) {
          await api.finishExtensionLogin(task.state, true);
          if (!stopped) { setTask(null); setMessage('登录已超时（5 分钟），请重新打开授权页。'); }
          return;
        }
        const result = await api.extensionRequest<{ done?: boolean; error?: string }>('GET', `/api/session/login/wait?state=${encodeURIComponent(task.state)}`);
        if (stopped) return;
        failures = 0;
        if (result.done) {
          await api.finishExtensionLogin(task.state).catch(() => {});
          if (stopped) return;
          setTask(null);
          if (result.error) setMessage(result.error);
          else {
            try {
              await reload(); await sync();
              if (mounted.current) setMessage('登录成功，账号池和模型已接入 API。可以继续添加下一个账号。');
            } catch (error) {
              if (mounted.current) setMessage(`登录已保存，但模型同步失败：${String(error)}。无需重复登录，请点击“接入 API / 同步模型”重试。`);
            }
          }
          return;
        }
        timer = setTimeout(() => void poll(), 2000);
      } catch (error) {
        if (stopped) return;
        failures += 1;
        if (failures < 5) { setMessage('授权结果暂时未连通，正在重试；请保留登录窗口。'); timer = setTimeout(() => void poll(), 3000); }
        else { void api.finishExtensionLogin(task.state, true).catch(() => {}); setMessage(`授权连接中断：${String(error)}。请重新开始登录。`); setTask(null); }
      }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  // The login task owns this polling lifecycle; avoid restarting it on parent polling.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task, reload]);
  const sms = provider === 'autoclaw' || provider === 'loomy';
  const desktopImport = ['raccoon', 'catpaw', 'autoclaw', 'autoclaw-intl'].includes(provider);
  const smsPath = provider === 'loomy' ? '/api/session/login/loomy/sms' : '/api/session/login/sms';
  const visible = accounts.filter(account => account.provider === provider);
  const checkinIds = new Set(center?.daily.providers.flatMap(group => group.accounts.map(account => account.id)) ?? []);
  return <section className="mm-extension-host">
    <header className="mm-api-panel-head"><div><h1>扩展账号池 / 每日签到</h1><p>个人自用组件。各渠道按优先级选路，限流或额度不足时切换账号；不会把订阅伪装成官方 API Key，也不会运行付费测试。</p></div>
      <div className="mm-inline-actions"><button className="btn btn-secondary" disabled={busy} onClick={() => void action(reload, '列表已更新')}><RefreshCw />刷新列表</button><button className="btn btn-primary" disabled={busy} onClick={() => void action(sync, '账号池与模型已接入 API')}><Plus />接入 API / 同步模型</button></div></header>
    {message && <div className="mm-api-message" role="status">{message}</div>}
    <nav className="mm-extension-providers" aria-label="扩展渠道">{EXTENSION_PROVIDERS.map(item => <button key={item.id} disabled={busy || !!task} className={`btn ${provider === item.id ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { setProvider(item.id); setCredentials(''); setCallback(''); }}><Globe size={16} />{item.label}<small>{accounts.filter(account => account.provider === item.id).length}</small></button>)}</nav>
    <section className="mm-api-panel mm-extension-login"><h2>添加 {EXTENSION_PROVIDERS.find(item => item.id === provider)?.label} 账号</h2>
      <div className="mm-extension-fields"><label>备注名<input value={name} onChange={event => setName(event.target.value)} placeholder="可选，方便区分多个账号" /></label>
      {provider === 'qoder' && <label>地区<select value={edition} onChange={event => setEdition(event.target.value)}><option value="cn">中国版（可签到）</option><option value="intl">国际版</option></select></label>}
      {sms ? <><label>手机号<input value={phone} onChange={event => setPhone(event.target.value)} autoComplete="tel" /></label><label>验证码<input value={code} onChange={event => setCode(event.target.value)} autoComplete="one-time-code" /></label>
        <button className="btn btn-secondary" disabled={busy || !phone} onClick={() => void action(async () => { const result = await api.extensionRequest<{ deviceId?: string }>('POST', `${smsPath}/send`, { provider, phone }); setDeviceId(result.deviceId ?? ''); }, '验证码已发送')} >发送验证码</button>
        <button className="btn btn-primary" disabled={busy || !phone || !code} onClick={() => void action(async () => { await api.extensionRequest('POST', `${smsPath}/verify`, { provider, phone, code, deviceId, name }); setCode(''); await sync(); }, '登录完成并接入 API')} >登录并添加</button></> : provider !== 'autoclaw-intl' && <button className="btn btn-primary" disabled={busy || !!task} onClick={() => void action(async () => {
          const login = await api.startExtensionLogin(provider, edition, name);
          if (!mounted.current) { await api.finishExtensionLogin(login.state, true); return; }
          setCallback(''); setTask({ ...login, provider, startedAt: Date.now() });
          if (!login.hosted) await openUrl(login.authUrl);
        }, '已打开官方授权页，完成登录后会自动接入。')}><Globe />网页登录 / 添加账号</button>}
      {desktopImport && <button className="btn btn-secondary" disabled={busy || !!task} onClick={() => void action(async () => { await api.extensionRequest('POST', '/api/accounts', { provider, edition, name, importDesktop: true }); await sync(); }, '桌面登录态已导入并接入 API')}>导入当前桌面登录态</button>}</div>
      {provider === 'trae' && <p>当前接入的是 Trae 国内 SOLO 通道，不支持国际版凭证。官网可能按网络地区限制访问；系统浏览器和独立窗口共用同一轮本机回调，不要修改回调端口。</p>}
      {provider === 'raccoon' && <p>请在弹出的独立窗口完成官方登录。每次使用全新会话，可添加多个账号；直接在外部浏览器登录无法把专用回调交回 C.le。</p>}
      {provider === 'qoder' && <p>支持网页登录，或在下方粘贴完整凭证 / {`{"pat":"你的个人访问令牌"}`}；不提供点了必失败的桌面导入。</p>}
      {provider === 'autoclaw-intl' && <p>国际版需要浏览器风控验证，先在官方客户端登录，再导入登录态或凭证；不会提供点了必失败的授权按钮。</p>}
      {task && <div className="mm-extension-fields"><span>等待 {EXTENSION_PROVIDERS.find(item => item.id === task.provider)?.label} 官方授权（5 分钟内）…{task.hosted && '独立窗口登录，每次可添加不同账号。'}</span><button className="btn btn-secondary" disabled={busy} onClick={() => void action(() => task.hosted ? api.openExtensionLogin(task.state) : openUrl(task.authUrl), '已重新打开授权页')}>重新打开授权页</button>
        {task.provider !== 'raccoon' && <button className="btn btn-secondary" disabled={busy} onClick={() => void action(() => openUrl(task.authUrl), '已交给系统浏览器打开；完成后保留本应用等待回调')}>用系统浏览器打开</button>}
        <button className="btn btn-secondary" disabled={busy} onClick={() => void action(() => navigator.clipboard.writeText(task.authUrl), task.provider === 'raccoon' ? '链接已复制；小浣熊须在本应用授权窗口完成，系统浏览器不能接回专用协议' : '授权链接已复制')}>复制授权链接</button>
        <input placeholder="没有自动回跳？粘贴完整回调链接" value={callback} onChange={event => setCallback(event.target.value)} /><button className="btn btn-secondary" disabled={busy || !callback} onClick={() => void action(async () => {
        const response = await api.extensionRequest<{ continue?: boolean; nextUrl?: string }>('POST', '/api/session/login/callback', { callbackUrl: callback, state: task.state });
        if (response.continue && response.nextUrl) await openUrl(response.nextUrl);
      }, '回调已提交，等待上游确认')}>提交回调</button><button className="btn btn-secondary" disabled={busy} onClick={() => void action(async () => { await api.finishExtensionLogin(task.state, true); setTask(null); setCallback(''); }, '登录已取消')}>取消</button></div>}
      <details><summary>粘贴已有账号凭证（Token / JSON）</summary><p>每次提交添加一个账号，不会覆盖其他账号。凭证只保存本机，不要分享或提交到 Git。</p><textarea value={credentials} onChange={event => setCredentials(event.target.value)} placeholder='{"accessToken":"…","refreshToken":"…"}' spellCheck={false} /><button className="btn btn-secondary" disabled={busy || !credentials.trim()} onClick={() => void action(async () => {
        const text = credentials.trim(); const payload = text.startsWith('{') ? JSON.parse(text) : { accessToken: text, token: text };
        await api.extensionRequest('POST', '/api/accounts', { ...payload, provider, edition, name }); setCredentials(''); await sync();
      }, '账号已添加并接入 API')}>添加凭证账号</button></details>
    </section>
    <div className="mm-extension-accounts">{visible.map(account => {
      const result = usage.find(row => row.id === account.id);
      const today = center?.daily.providers.flatMap(group => group.accounts).find(row => row.id === account.id)?.checkedInToday;
      return <article className="mm-api-panel" key={account.id}><h3>{account.name}</h3><p>{account.enabled ? '启用' : '暂停转发'} · {account.edition ?? account.provider}</p><p className="mm-extension-usage">{result?.error ?? (result ? usageLabel(result.usage) : '尚未刷新额度')}</p>
        <div className="mm-inline-actions"><button className="btn btn-secondary" disabled={busy} onClick={() => void action(async () => { const report = await api.extensionRequest<{ results: UsageResult[] }>('GET', `/api/accounts/usage?id=${account.id}`); const error = report.results.find(row => row.id === account.id)?.error; if (error) throw new Error(error); }, '额度已刷新')}><RefreshCw />刷新额度</button>
        {checkinIds.has(account.id) && <button className="btn btn-secondary" disabled={busy || today} onClick={() => void action(async () => { const report = await api.extensionRequest<{ failedCount?: number }>('POST', '/api/accounts/checkin', { id: account.id }); if (report.failedCount) throw new Error(JSON.stringify(report)); }, '签到完成，详细结果见下方记录')}><CalendarCheck />{today ? '今日已签到' : '签到'}</button>}
        <button className="btn btn-secondary" disabled={busy} onClick={() => void action(async () => { await api.extensionRequest('PATCH', `/api/accounts/${account.id}`, { enabled: !account.enabled }); await sync(); }, '账号状态已更新')}>{account.enabled ? '停用' : '启用'}</button>
        <button className="btn btn-secondary" disabled={busy} onClick={() => void (async () => { if (await confirm(`删除 ${account.name} 的扩展登录态？不影响其他账号。`, { title: '删除扩展账号', kind: 'warning' })) await action(async () => { await api.extensionRequest('DELETE', `/api/accounts/${account.id}`); await sync(); }, '扩展账号已删除'); })()}><Trash2 /></button></div></article>;
    })}{!visible.length && <p>还没有这个渠道的账号，请先登录；不会预填不存在的模型。</p>}</div>
    {auto && <section className="mm-api-panel"><h2><CalendarCheck size={20} />每天自动签到</h2><p>有接口的才显示。按本机时间每天一次，休眠错过会补签；不调用模型。WorkBuddy 继续使用原来的签到设置。</p>
      <div className="mm-extension-fields"><label><input type="checkbox" checked={auto.enabled} onChange={event => setAuto({ ...auto, enabled: event.target.checked })} />开启自动签到</label><label>时间<input type="time" value={auto.time} onChange={event => setAuto({ ...auto, time: event.target.value })} /></label>
      {auto.providerOptions.map(option => <label key={option.id}><input type="checkbox" checked={auto.providers.includes(option.id)} onChange={event => setAuto({ ...auto, providers: event.target.checked ? [...auto.providers, option.id] : auto.providers.filter(id => id !== option.id) })} />{option.label}</label>)}
      <button className="btn btn-primary" disabled={busy || !auto.providers.length} onClick={() => void action(() => api.extensionRequest('POST', '/api/auto-checkin', { enabled: auto.enabled, time: auto.time, providers: auto.providers }), '自动签到设置已保存')}>保存签到设置</button>
      <button className="btn btn-secondary" disabled={busy || auto.running} onClick={() => void action(async () => { const report = await api.extensionRequest<{ failedCount?: number; lastResult?: unknown }>('POST', '/api/auto-checkin/run'); if (report.failedCount) throw new Error(`部分账号签到失败，详情已记录：${JSON.stringify(report.lastResult ?? report)}`); }, '本轮签到完成')}>立即签到一次</button></div>
      <p>今日 {center?.daily.todayDone ?? 0} / {center?.daily.todayEligible ?? 0} 个账号已签到。CatPaw、Accio 没有接口，不会安排。</p>
      <details><summary>最近签到结果 / 失败原因</summary><pre>{JSON.stringify(auto.lastResult ?? center?.history ?? [], null, 2)}</pre></details></section>}
  </section>;
}
