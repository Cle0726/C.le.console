import { useCallback, useEffect, useState } from 'react';
import { confirm, open as openFileDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { BadgeCheck, Download, FileDown, FileUp, LogIn, LogOut, Plus, Power, Trash2 } from 'lucide-react';
import { jimengApiService } from '../services/jimengApiService';
import type { DoubaoWebAccountState } from '../types/jimengApi';

type Notice = { tone: 'success' | 'error' | 'info'; text: string };

// Doubao accounts for the API pool's Doubao chat. Same accounts and login as
// the 即梦 workbench: one browser login per account, cookies stay in C.le.
// After any change the parent re-syncs the pool (onChanged).
export function DoubaoWebPoolPanel({ onChanged, onNotice }: { onChanged: () => Promise<number>; onNotice: (notice: Notice) => void }) {
  const [accounts, setAccounts] = useState<DoubaoWebAccountState[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const state = await jimengApiService.getDoubaoWebState();
    setAccounts(state.accounts.filter((account) => account.platformId === 'doubao'));
    return state.accounts.filter((account) => account.platformId === 'doubao');
  }, []);

  useEffect(() => { void load().catch((error) => onNotice({ tone: 'error', text: `读取豆包账号失败：${String(error)}` })); }, [load, onNotice]);

  // Pool sync checks every enabled account's cookies with the Doubao server and
  // links the signed-in ones; returns how many are linked.
  const verify = async () => {
    const linked = await onChanged();
    await load();
    return linked;
  };

  const run = async (label: string, action: () => Promise<string | void>) => {
    setBusy(true);
    try {
      const text = await action();
      if (text) onNotice({ tone: 'success', text });
    } catch (error) {
      onNotice({ tone: 'error', text: `${label}失败：${String(error)}` });
    } finally {
      setBusy(false);
    }
  };

  const add = () => run('添加豆包账号', async () => {
    const before = new Set(accounts.map((account) => account.id));
    const state = await jimengApiService.addDoubaoWebAccount('doubao');
    const created = state.accounts.find((account) => account.platformId === 'doubao' && !before.has(account.id));
    await load();
    if (created) await jimengApiService.openDoubaoWebLogin(created.id);
    return '已打开豆包登录窗口。登录完成后点击该账号的“验证并接入”。';
  });

  const exportAll = () => run('导出豆包账号凭证', async () => {
    if (!await confirm('导出的文件包含豆包登录 Cookie，拿到文件的人可以登录这些账号。请只保存到可信位置，是否继续？', { title: '导出豆包账号', kind: 'warning' })) return;
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const path = await saveDialog({ defaultPath: `C.le-豆包账号凭证-${day}.json`, filters: [{ name: 'C.le 豆包凭证', extensions: ['json'] }] });
    if (!path) return;
    const result = await jimengApiService.exportDoubaoCredentialsToFile(path, accounts.map((account) => account.id));
    return `已导出 ${result.accountCount} 个豆包账号。${result.skippedAccounts.length ? `未导出：${result.skippedAccounts.join('；')}` : '请妥善保管凭证文件。'}`;
  });

  const importFile = () => run('导入豆包账号凭证', async () => {
    const selected = await openFileDialog({ multiple: false, filters: [{ name: 'C.le 豆包凭证', extensions: ['json'] }] });
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (!path) return;
    if (!await confirm('将从该文件导入豆包登录凭证。请只导入你自己导出、来源可信的文件，是否继续？', { title: '导入豆包账号', kind: 'warning' })) return;
    const result = await jimengApiService.importDoubaoCredentialsFromFile(path);
    const linked = await verify();
    return `${result.message}；API 账号池现有 ${linked} 个在线豆包账号。`;
  });

  const importDesktop = () => run('导入豆包桌面版账号', async () => {
    const scan = await jimengApiService.scanDoubaoDesktopProfiles();
    const ready = scan.profiles.filter((profile) => profile.hasCookieDatabase && !profile.alreadyImported).map((profile) => profile.profileDir);
    if (!ready.length) return scan.profiles.length ? '豆包桌面版的账号都已导入。' : '没有找到豆包桌面版的登录账号。';
    if (!await confirm(`找到 ${ready.length} 个豆包桌面版账号，导入前请先退出豆包桌面版。是否导入？`, { title: '导入豆包桌面版账号' })) return;
    const result = await jimengApiService.importDoubaoDesktopProfiles(ready);
    const linked = await verify();
    return `${result.message}；API 账号池现有 ${linked} 个在线豆包账号。`;
  });

  const status = (account: DoubaoWebAccountState) => !account.enabled ? '已停用'
    : account.desktopCookieSyncPending ? '待导入' : account.statusVerified && account.loggedIn ? '在线' : account.statusVerified ? '未登录' : '待验证';

  return <section className="mm-doubao-web-panel">
    <div className="mm-inline-actions">
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void add()}><Plus />添加账号（浏览器登录）</button>
      <button type="button" className="btn btn-secondary" disabled={busy || !accounts.length} onClick={() => void run('验证豆包账号', async () => `豆包服务端确认 ${await verify()}/${accounts.filter((account) => account.enabled).length} 个启用账号在线，已接入 API 账号池。`)}><BadgeCheck />全部验证并接入</button>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void importFile()}><FileUp />导入凭证</button>
      <button type="button" className="btn btn-secondary" disabled={busy || !accounts.length} onClick={() => void exportAll()}><FileDown />导出凭证</button>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void importDesktop()}><Download />从豆包桌面版导入</button>
    </div>
    <div className="mm-doubao-web-list">
      {accounts.map((account) => <article key={account.id} className={`mm-doubao-web-row${account.enabled ? '' : ' disabled'}`}>
        <div><strong>{account.name}</strong><small>{account.lastError || account.message}</small></div>
        <em className={account.statusVerified && account.loggedIn && account.enabled ? 'online' : ''}>{status(account)}</em>
        <div className="mm-inline-actions">
          <button type="button" className="btn btn-secondary" disabled={busy || !account.enabled} onClick={() => void run('打开登录窗口', async () => { await jimengApiService.openDoubaoWebLogin(account.id); return '已打开登录窗口；登录后点击“验证并接入”。'; })}><LogIn />登录</button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void run('验证豆包账号', async () => { await verify(); const now = (await load()).find((item) => item.id === account.id); return now?.loggedIn ? `${account.name} 在线，已接入 API 账号池。` : `${account.name} 未登录，请先点“登录”。`; })}><BadgeCheck />验证并接入</button>
          <button type="button" className="btn btn-secondary" disabled={busy || account.busy} onClick={() => void run('切换账号状态', async () => { await jimengApiService.setDoubaoWebAccountEnabled(account.id, !account.enabled); await load(); await onChanged(); })}><Power />{account.enabled ? '停用' : '启用'}</button>
          <button type="button" className="btn btn-secondary" disabled={busy || account.busy} onClick={() => void run('退出登录', async () => { await jimengApiService.logoutDoubaoWeb(account.id); await load(); await onChanged(); })}><LogOut />退出</button>
          <button type="button" className="btn btn-secondary danger" disabled={busy || account.busy} onClick={() => void run('删除账号', async () => {
            if (!await confirm(`删除豆包账号“${account.name}”？它的登录状态会一起清除，即梦工作台里也会消失。`, { title: '删除豆包账号', kind: 'warning' })) return;
            await jimengApiService.removeDoubaoWebAccount(account.id); await load(); await onChanged();
          })}><Trash2 />删除</button>
        </div>
      </article>)}
      {!accounts.length && <p className="mm-quota-hint">还没有豆包账号。点“添加账号”用浏览器登录，或导入凭证 / 豆包桌面版账号。</p>}
    </div>
  </section>;
}
