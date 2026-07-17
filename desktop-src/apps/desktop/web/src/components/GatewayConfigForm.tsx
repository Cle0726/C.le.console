import type { GatewayConfig } from '@desktop/contracts';

interface GatewayConfigFormProps {
  config: GatewayConfig;
  onChange(next: GatewayConfig): void;
}

function updateNumber(config: GatewayConfig, key: keyof GatewayConfig, value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  return {
    ...config,
    [key]: Number.isFinite(parsed) ? parsed : fallback,
  } satisfies GatewayConfig;
}

export function GatewayConfigForm({ config, onChange }: GatewayConfigFormProps) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>全局参数设置</h2>
          <p className="subtle">优先把网关本身跑通，并把影响可用性的关键参数显式化到桌面控制面。</p>
        </div>
      </div>

      <div className="form-grid">
        <label>
          <span>监听地址</span>
          <input
            value={config.listenHost}
            onChange={(event) => onChange({ ...config, listenHost: event.target.value })}
          />
        </label>

        <label>
          <span>监听端口</span>
          <input
            type="number"
            min={1}
            max={65535}
            value={config.listenPort}
            onChange={(event) => onChange(updateNumber(config, 'listenPort', event.target.value, 8787))}
          />
        </label>

        <label>
          <span>上游 Claude URL</span>
          <input
            placeholder="https://claude.ai"
            value={config.upstreamBaseUrl ?? ''}
            onChange={(event) => onChange({ ...config, upstreamBaseUrl: event.target.value })}
          />
        </label>

        <label>
          <span>MAX_RETRIES</span>
          <input
            type="number"
            min={1}
            max={20}
            value={config.maxRetries}
            onChange={(event) => onChange(updateNumber(config, 'maxRetries', event.target.value, 3))}
          />
        </label>

        <label>
          <span>COOLDOWN_MINUTES</span>
          <input
            type="number"
            min={1}
            max={1440}
            value={config.cooldownMinutes}
            onChange={(event) => onChange(updateNumber(config, 'cooldownMinutes', event.target.value, 15))}
          />
        </label>

        <label>
          <span>CLAUDE_DAILY_LIMIT</span>
          <input
            type="number"
            min={1}
            max={100000}
            value={config.claudeDailyLimit}
            onChange={(event) => onChange(updateNumber(config, 'claudeDailyLimit', event.target.value, 100))}
          />
        </label>

        <label>
          <span>流式首包超时 (ms)</span>
          <input
            type="number"
            min={1000}
            max={120000}
            value={config.streamFirstChunkTimeoutMs}
            onChange={(event) => onChange(updateNumber(config, 'streamFirstChunkTimeoutMs', event.target.value, 8000))}
          />
        </label>

        <label>
          <span>Transport 模式</span>
          <select
            value={config.transportMode}
            onChange={(event) => onChange({ ...config, transportMode: event.target.value as GatewayConfig['transportMode'] })}
          >
            <option value="direct_http">direct_http</option>
            <option value="auto">auto</option>
            <option value="browser_bridge">browser_bridge</option>
          </select>
        </label>

        <label>
          <span>Helper 模式</span>
          <select
            value={config.helperMode}
            onChange={(event) => onChange({ ...config, helperMode: event.target.value as GatewayConfig['helperMode'] })}
          >
            <option value="probe_only">probe_only</option>
            <option value="browser_fetch">browser_fetch</option>
            <option value="page_context">page_context</option>
            <option value="disabled">disabled</option>
          </select>
        </label>

        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={config.probeBeforeStart}
            onChange={(event) => onChange({ ...config, probeBeforeStart: event.target.checked })}
          />
          <span>启动前 probe helper</span>
        </label>

        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={config.preferBrowserOn403}
            onChange={(event) => onChange({ ...config, preferBrowserOn403: event.target.checked })}
          />
          <span>403 时优先升级到浏览器桥</span>
        </label>

        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={config.respectRetryAfter}
            onChange={(event) => onChange({ ...config, respectRetryAfter: event.target.checked })}
          />
          <span>尊重 Retry-After</span>
        </label>

        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={config.requireApiKey}
            onChange={(event) => onChange({ ...config, requireApiKey: event.target.checked })}
          />
          <span>要求本地 API Key</span>
        </label>

        <label className="full-width">
          <span>本地 API Key</span>
          <input
            placeholder="可选，用于限制 localhost 客户端访问"
            value={config.localApiKey ?? ''}
            onChange={(event) => onChange({ ...config, localApiKey: event.target.value })}
          />
        </label>
      </div>
    </section>
  );
}
