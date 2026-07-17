# Multi Platform CLI Proxy API

独立本地 OpenAI-compatible 反代服务，UI 样式同步 `F:\C.le.控制台` 现有深色面板风格。

## 启动

```bash
cd '/f/C.le.控制台/desktop-src/multi-platform-proxy-api'
npm run mock
npm start
```

访问：

```text
http://127.0.0.1:13978/
```

API Base URL：

```text
http://127.0.0.1:13978/v1
```

## 验证

```bash
npm run verify
```

## 接口

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/images/generations`
- `POST /v1/responses`（本轮实现 non-streaming pass-through，主要用于图片生成测试）
- `GET /admin/snapshot`
- `POST /admin/config`
- `POST /admin/reload`
- `POST /admin/runtime/reset`

`/v1/models` 会返回本地扩展字段 `_capabilities`，用于标记 route 支持 `chat` 还是 `image`。`/v1/chat/completions` 与 `/v1/images/generations` 会按 capability 做硬校验，避免 image-only model 误走聊天链路。

Admin Token 默认：

```text
local-admin-token
```

## 配置

首次启动会从 `config.example.json` 自动复制为 `config.json`。

真实平台接入示例：

```json
{
  "id": "openai-main",
  "providerId": "openai",
  "label": "OpenAI Main",
  "enabled": true,
  "priority": 10,
  "proxyId": "codex-us",
  "auth": {
    "type": "api_key",
    "apiKeyEnv": "OPENAI_API_KEY"
  }
}
```
