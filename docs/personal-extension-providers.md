# 个人扩展版

入口：多模型 API → **扩展账号 / 签到**。Kiro、GitHub Copilot 在旁边的独立登录页。

扩展账号池复用 Agent2API 2.9.7 的现成登录、模型目录、额度查询、凭证维护和协议适配。
接入 Qoder / QoderWork、Trae、小浣熊、CatPaw、AutoClaw、Accio、Loomy。
每个渠道独立账号池；使用自己的登录态，按上游授权和真实额度调用，不绕过计费。
同一个渠道可以继续添加多个自己的账号，不等于批量账号运营。

每日签到：小浣熊、AutoClaw 国内/国际、Qoder 中国版、Trae、Loomy 每日登录奖励。
没有签到接口的 CatPaw、Accio、Qoder 国际版不安排。
WorkBuddy 沿用原来的 C.le 签到设置；扩展引擎不接管它，更不会运行模型保活任务。
签到默认关闭，在页面选择渠道、时间后保存即可开启。应用须保持运行；睡眠后会补签。
每天去重，结果和失败原因持久保存。时间为电脑本机时间，活动是否存在最终以账号返回为准。

登录：网页授权支持 Qoder、Trae、小浣熊、CatPaw、Accio；国内 AutoClaw 和 Loomy
使用手机验证码。AutoClaw 国际版需要官方浏览器风控验证，当前使用桌面登录态导入或
粘贴凭证，不伪造通用 OAuth 按钮。模型仅在实际账号可用时同步，未知能力不填猜测值。
没有账号的渠道没有做真实订阅调用验证；离线测试不代表上游一定接受所有账号。
豆包工作 Agent 保留现有官方 CLI 接入，仍受 CLI 当前活动账号限制。
Muse 不默认把订阅转成通用 API，不能把单独付费的 API Key 算成订阅额度。

## 构建

```sh
node scripts/build-agent-bridge.mjs
npm run tauri -- build --config src-tauri/tauri.personal.conf.json --bundles app
```

默认构建不包含 Agent2API 可执行文件，个人配置才会打包它。
完整授权见 [Agent2API LICENSE](../sidecars/agent2api/LICENSE)：MIT 条款附加非商业限制，
个人版不能当纯 MIT 商业包销售。Kiro / Copilot 的 MIT 来源见
[CLIProxyAPIPlus NOTICE](../sidecars/cle-cliproxy/licenses/CLIProxyAPIPlus-NOTICE.md)。

账号库位于 C.le 共享数据目录的 `extension-providers` 子目录，目录权限 700，
私有桥接密钥权限 600。凭证保存在本机 SQLite，不可提交 Git 或公开导出。
管理端严格只监听 127.0.0.1，每个代理渠道使用单独的提供商白名单 Key。

## 不花积分的检查

```sh
node scripts/test-extension-bridge.mjs
node scripts/test-multi-model-quota.mjs
```

扩展桥接测试使用临时空账号库，只访问管理接口；不调用 `/v1` 模型推理。
它检查启动、鉴权、安全签到范围、配置校验/保存/运行和渠道密钥白名单。
