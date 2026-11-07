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
  localProxy: string;
  lastError: string;
  nodeCount: number;
}

export function SubscriptionProxyCard() {
  const [state, setState] = useState<SubscriptionProxyState | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

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
    setMessage('');
    try {
      const next = await invoke<SubscriptionProxyState>('subscription_proxy_refresh', { url });
      setState(next);
      setMessage(`已读取 ${next.nodeCount} 个节点。HTTP / SOCKS5 可直接用于工作台；其他协议需要本机 mihomo。`);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const apply = async (nodeId: string, enabled: boolean) => {
    setBusy(true);
    setMessage('');
    try {
      const next = await invoke<SubscriptionProxyState>('subscription_proxy_apply', { nodeId, enabled });
      setState(next);
      setMessage(enabled ? '工作台上游已改走这个订阅节点，不再使用系统代理。' : '已关闭订阅。工作台恢复走系统代理，或你单独填写的上游代理。');
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mm-api-panel">
      <header className="mm-api-panel-head">
        <div>
          <h2>订阅节点</h2>
          <p>只在这里打开时，工作台访问上游模型才走订阅节点。不打开时，仍只用电脑自己的系统代理，两套不会同时生效，也不会改写上面的上游代理地址。</p>
        </div>
      </header>
      <div className="mm-form-grid">
        <label className="wide">
          <span>订阅地址</span>
          <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/clash/subscribe" />
        </label>
        <div className="wide" style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-secondary" disabled={busy || !url.trim()} onClick={() => void refresh()}>读取节点</button>
          {state?.enabled && (
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void apply('', false)}>关闭订阅，改回系统代理</button>
          )}
        </div>
      </div>
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
              <small>{node.kind} · {node.server}:{node.port}{state.enabled && state.selectedId === node.id ? ' · 使用中' : ''}{node.usable ? '' : ' · 需 mihomo'}</small>
            </button>
          ))}
        </div>
      )}
      {message && <p className="mm-quota-hint">{message}</p>}
      {state?.lastError && <p className="mm-quota-error">{state.lastError}</p>}
    </section>
  );
}
