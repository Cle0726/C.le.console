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
  splitRouting: boolean;
  extraNodeDomains: string[];
}

interface ConnectivityResult { provider: string; reachable: boolean; status: number | null; error: string }

export function SubscriptionProxyCard() {
  const [state, setState] = useState<SubscriptionProxyState | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [content, setContent] = useState('');
  const [extraDomains, setExtraDomains] = useState('');

  const load = async () => {
    const next = await invoke<SubscriptionProxyState>('subscription_proxy_get');
    setState(next);
    setUrl(next.url);
    setExtraDomains((next.extraNodeDomains ?? []).join(', '));
  };

  const saveRouting = async (split: boolean) => {
    setBusy(true);
    try {
      const next = await invoke<SubscriptionProxyState>('subscription_proxy_set_routing', {
        split,
        extraDomains: extraDomains.split(/[\s,，;]+/).filter(Boolean),
      });
      setState(next);
      setExtraDomains(next.extraNodeDomains.join(', '));
      setMessage(next.splitRouting
        ? '已切换为分流：只有 Gemini / Antigravity / Codex / GPT / Claude 等海外服务走节点，豆包、WorkBuddy 等国内平台直连。立即生效。'
        : '已切换为全部走节点：控制台的所有外部请求都经过节点。立即生效。');
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
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
      setMessage(enabled
        ? (next.splitRouting
          ? '节点已启动。海外 AI 服务（授权登录、额度查询、模型调用）走节点，国内平台直连；系统代理不受影响。'
          : '节点已启动。控制台全部外部请求走节点；系统代理不受影响。')
        : '已关闭订阅，恢复原有代理设置。');
    } catch (error) {
      setMessage(String(error));
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const probe = async () => {
    setBusy(true);
    setMessage('正在测试 OpenAI、Google、Antigravity 经节点以及国内平台直连，最多等待 48 秒…');
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
          <p>不用开系统代理也能登录和调用 Gemini / Antigravity / Codex / GPT 等海外账号：节点只作用于控制台本身、它启动的服务和授权浏览器，不修改系统代理。默认分流——海外 AI 服务走节点，豆包、WorkBuddy 等国内平台直连。订阅地址打不开时，可粘贴订阅内容或单个节点链接。Windows x64 安装包内含节点内核，其他平台需自行安装 mihomo。</p>
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
        <div className="wide">
          <span>分流方式</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
            <button type="button" className={`btn ${state?.splitRouting !== false ? 'btn-primary' : 'btn-secondary'}`} disabled={busy || !state} onClick={() => void saveRouting(true)}>只有海外 AI 走节点（推荐）</button>
            <button type="button" className={`btn ${state?.splitRouting === false ? 'btn-primary' : 'btn-secondary'}`} disabled={busy || !state} onClick={() => void saveRouting(false)}>全部走节点</button>
          </div>
        </div>
        {state?.splitRouting !== false && (
          <label className="wide">
            <span>额外走节点的域名（可选，逗号分隔，含子域名）</span>
            <input value={extraDomains} onChange={(event) => setExtraDomains(event.target.value)} onBlur={() => { if (state && extraDomains !== state.extraNodeDomains.join(', ')) void saveRouting(true); }} placeholder="例如 example-ai.com" autoComplete="off" />
          </label>
        )}
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
