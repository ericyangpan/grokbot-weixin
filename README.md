# Weixin Multi-Provider Bot

个人微信 iLink Bot：通过微信私聊调用 OpenDoor、Zhongdiwa 或 DeepSeek 官方 API。运行在 Cloudflare Workers + SQLite Durable Object，不需要 NAS、VPS 或电脑常驻。

## 当前功能

- 微信扫码登录 iLink Bot。
- Cloudflare Durable Object Alarm 持续轮询微信私聊。
- OpenDoor 使用 OpenAI Chat Completions 兼容 API。
- Zhongdiwa 使用 OpenAI Responses API，并动态读取 `/v1/models` 模型目录。
- 通过 `/provider` 在 DeepSeek、OpenDoor 和 Zhongdiwa 之间切换。
- 通过 `/model list` 动态查看当前服务商的模型，并用 `/model <模型ID>` 切换。
- `/model deepseek` 切换到 DeepSeek 官方 API；`/model custom` 恢复 OpenDoor。
- 将所选模型的回复发回微信。
- 只处理白名单中的私聊发送者；群聊和机器人自身消息会被忽略。
- 对话历史默认最多 30 轮、约 12000 字、24 小时；发送 `/new` 或 `/reset` 清空历史。
- 微信语音使用微信提供的转写文本。当前文字模型接入不会把图片作为视觉输入识别。

## Cloudflare 部署（适合 iPhone Safari）

1. 在 Cloudflare Dashboard 打开 **Workers & Pages**，选择仓库 `aklancc/grokbot-weixin`，分支选择 `deepseek-cloudflare`。
2. 使用仓库中的 `wrangler.toml`。Durable Object SQLite binding 和 migrations 已写在配置中。
3. Workers Builds 安装命令使用 `npm ci`，部署命令使用 `npx wrangler deploy`。
4. 在 Worker 的 **Settings → Variables and Secrets** 中配置：
   - **Variable** `AI_API_BASE`：OpenDoor API 地址，例如 `https://ai.opendoor.sbs/v1`。
   - **Secret** `AI_API_KEY`：OpenDoor API Key。
   - **Variable** `AI_MODEL`：OpenDoor 默认模型 ID。
   - **Variable** `ZHONGDIWA_API_BASE`：默认 `https://www.zhongdiwa.com/v1`，可不填。
   - **Secret** `ZHONGDIWA_API_KEY`：中低洼 API Key。只有要使用中低洼时才需要配置。
   - **Variable** `ZHONGDIWA_MODEL`：默认模型 ID，默认值 `gpt-5.5`。
   - **Variable** `ZHONGDIWA_ACTOR_AUTHORIZATION`：默认 `local-image-extension`，按服务商文档要求设置。
   - **Secret** `DEEPSEEK_API_KEY`：DeepSeek 官方 API Key。
   - **Secret** `BRIDGE_TOKEN`：高强度随机密码，用于保护登录管理接口。
5. 保存后触发一次新部署，让变量和 Secret 生效。
6. 打开 Worker 的 `/login` 页面，输入 `BRIDGE_TOKEN`，开始微信扫码登录。
7. 在微信中扫码并确认。登录成功后，iLink 返回的扫码用户 ID 会被加入白名单。
8. 给机器人发送一条私聊消息测试。

## 微信命令

- `/provider`：查看服务商切换帮助。
- `/provider deepseek`：切换 DeepSeek 官方 API。
- `/provider opendoor`：切换 OpenDoor。
- `/provider zhongdiwa`：切换中低洼 Responses API。
- `/model list`：读取当前服务商的模型目录。
- `/model <模型ID>`：切换当前服务商模型。
- `/model deepseek`：兼容旧命令，切换 DeepSeek 官方 API。
- `/model custom`：兼容旧命令，切换 OpenDoor。

## 安全注意事项

- 不要把 `AI_API_KEY`、`ZHONGDIWA_API_KEY`、`DEEPSEEK_API_KEY` 或 `BRIDGE_TOKEN` 写入 GitHub、普通 Variables 或公开截图；必须使用 Cloudflare Secret。
- 如密钥曾在聊天、截图或公开仓库中暴露，请先在服务商后台撤销并重新生成，再将新密钥存入 Cloudflare Secret。
- 本项目按个人账号使用设计。不会自动把任意第一个来信者加入白名单；若 iLink 登录响应没有提供扫码者 ID，机器人会保持不回复，避免陌生人抢先占用。
- 只处理私聊，不处理群聊。
- 如需检查状态，可访问 Worker 的 `/health`。健康信息只显示是否已登录、白名单数量及 API 密钥是否已配置，不显示密钥。
- 各服务商的价格、额度及模型可用性以各自平台账户为准；Cloudflare 使用量受账号计划限制。

## 本地检查

需要 Node.js 22：

```bash
npm ci
npm test
npm run build
```

`npm run build` 会执行 Node 类型检查、Worker 类型检查和 Wrangler dry-run。真实微信扫码与线上 iLink 长轮询必须部署后验证。

## 技术说明

iLink 协议实现参考腾讯开源的 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT）；本仓库为独立实现，不运行 OpenClaw。Cloudflare Worker 使用一个 SQLite Durable Object 保存登录状态、白名单、轮询游标和对话历史。
