# WorkBuddy 多模型 API 实测记录

## 后续更新：上下文容量（2026-10-07）

已修复接入时丢失 `maxInputTokens` / `maxOutputTokens` 导致客户端使用小窗口默认值的问题，并替换当前安装的应用。
按每个模型的上游最高可选容量同步，不把桌面端的 `defaultLength` 当成最大容量，也不虚构所有模型都是 1M。

| 最高输入容量 | 模型 |
| --- | --- |
| 1,000,000 | DeepSeek V4 Pro / V4.1 Flash、GLM 5.2 / 5.3 / 5.3 Flash、Kimi K3 / K2.8 Preview、Space Bunny |
| 960,000 | Hy4 Preview |
| 512,000 | MiniMax M3 |
| 256,000 | Auto、Kimi K2.6 / K2.7 |
| 200,000 | GLM 5.1 / 5V Turbo |
| 192,000 | Hy3 / Hy3-X |

已更新 OpenAI / Codex 模型目录、原生注册表、Gemini 目录和 Ollama `/api/show` 的容量字段，模型页显示真实容量。
没有自动增加单次回复长度，也没有修改第三方客户端独立保存的压缩阈值或手动上下文设置。

用户要求停止消耗积分的验证。本轮仅做本地测试和只读目录比较：

```json
{"result":"READ_ONLY_CAPACITY_PASS","accounts":5,"models":17,"inferenceRequests":0}
```

只读检查：`node scripts/check-workbuddy-capacities.mjs`。
本轮没有发送推理请求，未实测满容量长文本。下方是上一轮已获授权的真实调用记录，后续若再运行收费测试需要新的授权。

---

验收时间：2026-10-07。测试对象是已安装并运行的
`/Applications/C.le.控制台.app`，不是模拟服务器。

## 真实调用结果

使用已有网关 Key，通过 `http://127.0.0.1:1466/v1` 调用；没有打印或保存 Key、登录 Token、手机号。

| 检查项 | 实测结果 |
| --- | --- |
| `/v1/models` | 暴露 17 个账号上游目录中的 `workbuddy/` 模型，接入 5 个账号 |
| Chat Completions 非流式，`workbuddy/hy3` | HTTP 200，回答 `OK`，4.467 秒 |
| Chat Completions 流式，`workbuddy/hy3` | HTTP 200，回答 `OK`，正常 `stop` 和 `[DONE]`，6.719 秒 |
| Responses，`workbuddy/hy3` | HTTP 200，正确 response/output，回答 `OK`，2.381 秒 |
| 工具调用，`workbuddy/hy3` | HTTP 200，`lookup({"city":"Shanghai"})`，`finish_reason=tool_calls`，6.403 秒 |
| 账号池完整轮询补测 | HTTP 200，回答 `OK`，2.188 秒 |
| 收费模型 `workbuddy/kimi-k3-1` | HTTP 200，回答 `OK`，217 tokens，10.406 秒，官方返回 `credit=0.32` |

第二轮官方余额前后对比（账号匿名编号与网关配置顺序一致）：

```json
{
  "before": [399.74, 300, 800, 2300, 901.27000001],
  "after": [399.74, 299.68, 800, 2300, 901.27000001],
  "decreasedAccounts": 1,
  "creditsSpent": 0.32,
  "reportedCredit": 0.32,
  "result": "LIVE_GATEWAY_PASS"
}
```

第一轮收费调用也完成了官方余额核对：400 → 399.74，减少 0.26 积分，与当次返回 `credit=0.26` 一致。
两次收费测试合计扣除 0.58 积分。官方扣费入账有延迟，不能拿即时余额未变化或仅 `usage.credit` 作为完整验收。

## 当前应用中的核对

- 进程主程序与 sidecar 均来自 `/Applications/C.le.控制台.app/Contents/MacOS/`。
- 窗口标题是 `C.le. 多模型 API 服务`。
- 顶部有独立 `WorkBuddy API` 入口，嵌入原有多账号登录与配额管理。
- 账号池实际调度计数为 `[3, 3, 2, 2, 1]`，全部成功，失败均为 0；五个账号均参与真实请求。
- “刷新全部”成功更新官方配额；账号池显示第二个账号余额 299.68。
- 自动模型同步已启用，当前间隔 60 分钟；也可手动“接入 API / 同步账号和模型”。
- `codesign --verify --deep --strict`、前端类型检查、Go 单元测试/竞争检查以及 WorkBuddy 相关 Rust 测试通过。

入口：多模型 API → WorkBuddy API → 添加账号 → 接入 API / 同步账号和模型。
接入后继续使用现有 Base URL 和 Key，模型名为 `/v1/models` 返回的 `workbuddy/...`。

## 复测

```sh
node scripts/test-workbuddy-gateway.mjs --run
```

此命令会发送少量真实请求并消耗积分。只有模型回答、流式终止、Responses、工具调用以及官方余额扣减都成立才输出 `LIVE_GATEWAY_PASS`；余额最多等待 5 分钟，仅重查余额，不重复收费请求。

## 边界

- 这是 WorkBuddy 账号额度的调用通道，不是把额度转移给其他服务商。
- 当前保存的五个账号在账号页显示 FREE，因此本次直接证明的是免费/活动积分可通过网关真实调用和扣减；没有冒充已验证付费订阅账号。
- 17 个目录模型不等于逐个完成推理验收；本次实际调用了 `hy3`、`kimi-k3-1`，并在前期验证了 `space-bunny`。
- 故障注入测试使用本地测试服务器；它们验证 401 刷新、业务错误、截断流和协议转换，但不冒充官方服务实际过期或零额度的账号测试。
- Git 同步仅包含源码、测试脚本和说明；真实账号配置、凭证及打包产物不进入仓库。
