import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface SubscriptionNode {
  id: string;
  name: string;
  kind: string;
  server: string;
  port: number;
  usable: boolean;
}

interface SubscriptionProxyState {
  url: string;
  nodes: SubscriptionNode[];
  selectedId: string;
  enabled: boolean;
  ready: boolean;
  localProxy: string;
  lastError: string;
  nodeCount: number;
}

interface ConnectivityResult { provider: string; reachable: boolean; status: number | null; error: string }

export function SubscriptionProxyCard() {
  const [state, setState] = useState<SubscriptionProxyState | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [content, setContent] = useState('');

  const load = async () => {
    const next = await invoke<SubscriptionProxyState>('subscription_proxy_get');
    setState(next);
    setUrl(next.url);
  };

  useEffect(() => {
    void load().catch((error) => setMessage(String(error)));
  }, []);

  const refresh = async () => {
    setBusy(true);
    setMessage('正在读取订阅，最多等待 25 秒…');
    try {
      const next = await invoke<SubscriptionProxyState>('subscription_proxy_refresh', { url });
      setState(next);
      setMessage(`已读取 ${next.nodeCount} 个节点，请点击一个节点启用。`);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const importContent = async () => {
    setBusy(true);
    setMessage('正在解析节点…');
    try {
      const next = await invoke<SubscriptionProxyState>('subscription_proxy_import', { content });
      setState(next);
      setContent('');
      setMessage(`已导入 ${next.nodeCount} 个节点，请点击一个节点启用。`);
    } catch (error) {
      setMessage(`导入失败：${String(error).replace(/^Error:\s*/, '')}`);
    } finally {
      setBusy(false);
    }
  };

  const apply = async (nodeId: string, enabled: boolean) => {
    setBusy(true);
    setMessage(enabled ? '正在启动节点并更新服务…' : '正在关闭订阅节点…');
    try {
      const next = await invoke<SubscriptionProxyState>('subscription_proxy_apply', { nodeId, enabled });
      setState(next);
      setMessage(enabled ? '节点已启动。工作台授权、额度查询和模型请求将使用该节点；不会修改系统代理。' : '已关闭订阅，恢复原有代理设置。');
    } catch (error) {
      setMessage(String(error));
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const probe = async () => {
    setBusy(true);
    setMessage('正在通过当前节点测试 OpenAI 和 Google 授权页面，最多等待 24 秒…');
    try {
      const results = await invoke<ConnectivityResult[]>('subscription_proxy_probe');
      setMessage(results.map((result) => result.reachable
        ? `${result.provider}：收到响应（HTTP ${result.status}）`
        : `${result.provider}：连接失败（${result.error}）`).join('；') + '。连接成功不代表账号授权一定可用。');
    } catch (error) {
      setMessage(`测试失败：${String(error).replace(/^Error:\s*/, '')}`);
    } finally { setBusy(false); }
  };

  return (
    <section className="mm-api-panel">
      <header className="mm-api-panel-head">
        <div>
          <h2>订阅节点</h2>
          <p>节点仅供工作台及其授权浏览器使用，不修改系统代理。使用前请选择一个节点；如果订阅地址无法访问，可粘贴订阅内容或单个节点链接。Windows x64 安装包内含节点内核，其他平台需自行安装 mihomo。</p>
        </div>
      </header>
      <div className="mm-form-grid">
        <label className="wide">
          <span>订阅地址</span>
          <input type="password" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/clash/subscribe" autoComplete="off" />
        </label>
        <div className="wide" style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-secondary" disabled={busy || !url.trim()} onClick={() => void refresh()}>{busy ? '处理中…' : '读取订阅'}</button>
          {state?.enabled && (
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void apply('', false)}>关闭订阅，恢复原有设置</button>
          )}
          {state?.ready && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void probe()}>测试授权连接</button>}
        </div>
        <label className="wide">
          <span>粘贴订阅内容或节点链接</span>
          <textarea value={content} onChange={(event) => setContent(event.target.value)} rows={3} placeholder="Clash YAML、base64 订阅内容或节点链接" />
        </label>
        <div className="wide"><button type="button" className="btn btn-secondary" disabled={busy || !content.trim()} onClick={() => void importContent()}>导入粘贴内容</button></div>
      </div>
      <p className="mm-quota-hint">{state?.enabled ? (state.ready ? `节点已启动 · ${state.localProxy}` : '节点未就绪；工作台不会自动改为直连，请重新选择节点') : '尚未启用订阅节点'}</p>
      {state && state.nodes.length > 0 && (
        <div className="mm-form-grid" style={{ marginTop: 12 }}>
          {state.nodes.map((node) => (
            <button
              key={node.id}
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => void apply(node.id, true)}
              style={{ justifyContent: 'space-between', opacity: state.enabled && state.selectedId === node.id ? 1 : 0.85 }}
            >
              <span>{node.name}</span>
              <small>{node.kind} · {node.server}:{node.port}{state.enabled && state.selectedId === node.id ? ' · 使用中' : ''}{node.usable ? '' : ' · 需要节点内核'}</small>
            </button>
          ))}
        </div>
      )}
      {message && <p className="mm-quota-hint" role="status" aria-live="polite">{message}</p>}
      {state?.lastError && <p className="mm-quota-error">{state.lastError}</p>}
    </section>
  );
}
