import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, stat } from '@tauri-apps/plugin-fs';
import { Download, Upload } from 'lucide-react';
import * as workbuddy from '../../services/workbuddyService';
import { emitAccountsChanged } from '../../utils/accountSyncEvents';

export function WorkbuddyDataActions({ ids, onImported }: { ids: string[]; onImported: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const transfer = async (kind: 'import' | 'export') => {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      if (kind === 'import') {
        const path = await open({ multiple: false, filters: [{ name: 'WorkBuddy 账号备份', extensions: ['json'] }] });
        if (!path || Array.isArray(path)) return;
        if ((await stat(path)).size > 10 * 1024 * 1024) throw new Error('备份超过 10MB，请分批导入');
        const imported = await workbuddy.importWorkbuddyFromJson(await readTextFile(path));
        const count = new Set(imported.map(account => account.id)).size;
        try {
          await onImported();
          await emitAccountsChanged({ platformId: 'workbuddy', reason: 'import' });
          setMessage(`已导入 / 合并 ${count} 个账号，其他账号保留。`);
        } catch {
          setMessage(`已导入 / 合并 ${count} 个账号，但列表刷新失败。请刷新页面，无需重复导入。`);
        }
      } else {
        const directory = await invoke<string>('get_downloads_dir').catch(() => '');
        const day = new Date();
        const stamp = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
        const path = await save({ defaultPath: `${directory ? `${directory.replace(/[\\/]$/, '')}/` : ''}workbuddy_accounts_${stamp}.json`, filters: [{ name: 'WorkBuddy 账号备份', extensions: ['json'] }] });
        if (!path) return;
        await invoke('export_workbuddy_backup_file', { path, accountIds: ids });
        setMessage(`已导出 ${ids.length} 个账号。备份含登录凭证，请妥善保管。`);
      }
    } catch (error) { setMessage(`${kind === 'import' ? '导入' : '导出'}失败：${String(error)}`); }
    finally { setBusy(false); }
  };
  return <section className="workbuddy-data-actions" aria-label="WorkBuddy 账号备份">
    <div><strong>账号数据备份</strong><small>包含登录凭证、标签、额度快照和签到记录；不要公开分享。</small></div>
    <div className="workbuddy-data-buttons">
      <button className="btn btn-secondary" disabled={busy} onClick={() => void transfer('import')}><Download size={15} />一键导入</button>
      <button className="btn btn-secondary" disabled={busy || !ids.length} onClick={() => void transfer('export')}><Upload size={15} />导出全部 ({ids.length})</button>
    </div>
    {message && <p role="status">{message}</p>}
  </section>;
}
