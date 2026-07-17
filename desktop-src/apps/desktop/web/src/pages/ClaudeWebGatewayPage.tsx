import { useEffect, useMemo, useState } from 'react';
import type { GatewaySnapshot } from '@desktop/contracts';
import { GatewayConfigForm } from '@/components/GatewayConfigForm';
import { GatewayStatusCard } from '@/components/GatewayStatusCard';
import { SessionAccountsTable } from '@/components/SessionAccountsTable';
import { desktopApi } from '@/lib/desktopApi';

export function ClaudeWebGatewayPage() {
  const [snapshot, setSnapshot] = useState<GatewaySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh(options?: { silent?: boolean }) {
    if (!options?.silent) {
      setLoading(true);
    }
    setError(null);
    try {
      const next = await desktopApi.getGatewaySnapshot();
      setSnapshot(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh({ silent: true });
    }, 3000);
    return () => window.clearInterval(timer);
  }, []);

  const modelNames = useMemo(
    () => snapshot?.models.map((model) => model.id).join('、') || '暂无',
    [snapshot?.models],
  );

  async function saveAll() {
    if (!snapshot) {
      return;
    }
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const next = await desktopApi.saveGatewayConfig(snapshot.config);
      setSnapshot(next);
      setMessage('配置已保存。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function wrapBusy(action: () => Promise<unknown>, successMessage: string) {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await action();
      await refresh();
      setMessage(successMessage);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }


  async function testGatewayChat() {
    await wrapBusy(async () => {
      const result = await desktopApi.testGatewayChat('你好', 'claude-sonnet-5');
      if (!result.ok) {
        throw new Error(`测试失败 HTTP ${result.status}: ${result.rawBody}`);
      }
      setMessage(`测试发送成功：${result.responseText || result.rawBody}`);
    }, '测试发送完成。');
  }

  async function copyApiUrl() {
    if (!snapshot) {
      return;
    }
    const text = snapshot.status.apiBaseUrl;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', 'true');
        textarea.style.position = 'absolute';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      setMessage(`已复制 ${text}`);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  if (loading || !snapshot) {
    return <main className="page-shell"><p>正在加载桌面网关状态…</p></main>;
  }

  return (
    <main className="page-shell">
      <GatewayStatusCard
        status={snapshot.status}
        authStatus={snapshot.authStatus}
        saving={saving}
        busy={busy}
        onSaveAll={saveAll}
        onToggle={(nextRunning) =>
          wrapBusy(
            () => (nextRunning ? desktopApi.startGateway() : desktopApi.stopGateway()),
            nextRunning ? '本地网关已启动。' : '本地网关已停止。',
          )
        }
        onLaunchLogin={() => wrapBusy(() => desktopApi.launchClaudeLogin(), '已拉起 Claude 登录辅助器。')}
        onCopyApiUrl={copyApiUrl}
        onTestChat={testGatewayChat}
      />

      {message ? <div className="callout success">{message}</div> : null}
      {error ? <div className="callout error">{error}</div> : null}

      <section className="panel stats-panel">
        <div>
          <p className="eyebrow">运行态</p>
          <h2>当前网关摘要</h2>
        </div>
        <div className="stats-grid">
          <article>
            <span>已配置账号</span>
            <strong>{snapshot.config.accounts.length}</strong>
          </article>
          <article>
            <span>模型列表</span>
            <strong>{modelNames}</strong>
          </article>
          <article>
            <span>登录导出</span>
            <strong>{snapshot.authStatus?.authenticated ? '可用' : '未就绪'}</strong>
          </article>
        </div>
      </section>

      <GatewayConfigForm
        config={snapshot.config}
        onChange={(config) => setSnapshot({ ...snapshot, config })}
      />

      <SessionAccountsTable
        accounts={snapshot.config.accounts}
        runtimeStates={snapshot.runtimeStates}
        defaultDailyLimit={snapshot.config.claudeDailyLimit}
        onChange={(accounts) => setSnapshot({ ...snapshot, config: { ...snapshot.config, accounts } })}
      />
    </main>
  );
}
