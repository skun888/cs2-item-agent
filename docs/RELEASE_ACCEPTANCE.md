# 发布与功能升级验收标准

本文是 CS2 Item Agent 源码预发布、正式发布和功能升级的统一验收门槛。验收必须基于可复现证据，不能把“配置文件存在”“MCP 已连接”或“Key 已读取”单独当作功能可用。

## 状态定义

| 状态 | 含义 |
| --- | --- |
| `PASS` | 本次验收已取得满足标准的证据 |
| `FAIL` | 实际结果不符合标准，阻止发布 |
| `NOT_RUN` | 尚未执行，不能宣称已验证 |
| `NOT_APPLICABLE` | 本次发布明确不包含该能力 |
| `BLOCKED_EXTERNAL` | 被提供方故障、权限或网络阻断；不能记为通过，发布说明必须披露 |
| `CONFIGURED_UNVERIFIED` | 当前进程读到配置，但尚未证明凭据、权限、额度和网络有效 |

验收记录必须包含日期、Commit、操作系统、Node.js 版本、Agent 客户端与版本。截图和日志必须脱敏，不得保存 Key、Token、Webhook、代理认证、Cookie、真实 SteamID 或私有库存。

## A. 自动化发布门槛

在干净依赖环境执行：

```bash
npm ci
npm run acceptance:check
```

全部命令必须以退出码 0 完成，并满足：

- Node.js 主版本不低于 24；
- canonical Skill、客户端 Skill 入口和全部引用一致、可解析；
- Codex、Claude Code/Qoder、Trae、WorkBuddy 的项目 MCP 配置无密钥、无用户绝对路径，并统一调用 `scripts/run-mcp.mjs`；
- 严格类型检查和构建成功；
- 全部自动化测试通过；
- stdio MCP 完成真实协议握手，工具数量精确为 42；
- `health_check` 返回 `ok: true`、`usageGuide` 和 `configurationGuide`；
- 配置引导只返回变量名、状态和说明，不返回 `apiKey`、`apiToken`、`webhookUrl` 或 `proxyUrl` 字段；
- `.env.example` 的秘密项保持空白，`.env`、数据库和本地运行状态继续被 Git 忽略。

GitHub Actions 必须在 Windows 与 Linux 的 Node.js 24 环境通过同一个 `acceptance:check`。本地通过不能替代 CI，CI 通过也不能替代下面的实机和真实数据验收。

## B. 干净 Clone 与 Agent 实机验收

使用不含 `node_modules`、`dist`、`.env` 和数据库的新目录：

1. 安装 Node.js 24 或更高版本并 Clone 指定 Commit。
2. 用目标 Agent 打开仓库，完成客户端要求的项目信任或本地 MCP 批准。
3. 不手动执行 `npm install`、`npm run build`、迁移或 `npm run mcp`。
4. 确认统一启动器自动创建 `.env`、安装锁定依赖、构建、执行迁移并启动 stdio MCP。
5. 直接询问“怎么开始”或“我的 API Key 配置好了吗”。
6. 确认 Agent 调用 `health_check`，说明六类能力、四项本地配置及安全示例。
7. 在 `.env` 直接填写需要的配置，重启或重新加载 MCP，再确认状态变为 `CONFIGURED_UNVERIFIED`。

通过条件：普通用户除 Node.js、Clone、客户端安全批准、编辑本地 `.env` 和重启 MCP 外，不需要手动配置服务器命令、仓库绝对路径或 npm 开发命令。

### 客户端证据等级

| 客户端 | 项目配置 | 自动化契约 | 实机状态 |
| --- | --- | --- | --- |
| Codex | `.codex/config.toml` | 纳入 `mcp:config:check` | 未执行实机前记为 `NOT_RUN` |
| Claude Code | `.mcp.json` | 纳入 `mcp:config:check` | 未执行实机前记为 `NOT_RUN` |
| Qoder | `.mcp.json` | 纳入 `mcp:config:check` | 未执行实机前记为 `NOT_RUN` |
| Trae | `.trae/mcp.json` | 纳入 `mcp:config:check` | 2026-07-22 Windows 干净 Clone 已取得 `PASS` 证据 |
| WorkBuddy | `.workbuddy/mcp.json` | 纳入 `mcp:config:check` | 未执行实机前记为 `NOT_RUN` |

只有取得对应实机证据的客户端才能标注“实机已验证”。仅通过配置契约的客户端应表述为“已提供项目级兼容配置”，不能扩大宣传。

## C. 配置与真实只读能力验收

`health_check` 不请求远程接口。每个发布声称可用的数据源都必须另外完成一次代表性只读调用：

| 能力 | 前置配置 | 代表性验收 | 通过条件 |
| --- | --- | --- | --- |
| SteamDT 行情 | `STEAMDT_API_KEY` | `get_market_prices` 查询准确的 `marketHashName` | 返回 SteamDT 来源、观察时间和非空有效报价，或按接口契约明确报告无覆盖 |
| CSQAQ 增强数据 | `CSQAQ_API_TOKEN` 与公网 IP 绑定 | `resolve_csqaq_item`，再按本次发布能力选择持有人/供给等只读工具 | 提供方认证成功，目标能力返回带覆盖边界的合法结构 |
| Steam 公开库存 | 无 Key；受限网络可选 `STEAM_PROXY_URL` | `check_public_inventory`，通知保持关闭 | 公开库存成功；私密、限流或失败必须为未知，不得伪装成空库存 |
| 企业微信通知 | 可选 `WECHAT_WEBHOOK_URL` | `test_enterprise_wechat` | 仅在用户明确要求时执行且真实消息送达；未配置不阻止分析能力发布 |

真实数据验收不得在 CI 中自动使用个人凭据。验收报告只保存提供方、状态、时间、数量、字段名和脱敏错误，不保存响应中的个人数据或秘密。

## D. 安全与副作用验收

以下任一失败都阻止发布：

- 健康检查、配置引导、错误、日志或报告回显秘密值；
- 未经明确意图发送企业微信消息、运行告警/库存监控或记录 DIY 反馈；
- 未经确认直接创建组合告警；
- 把私密、限流、失败或不完整库存当作空库存或无变化；
- 把 CSQAQ 监控样本排行描述为全网排行；
- 把挂单价描述为成交价，或承诺收益、必然涨跌；
- 执行购买、出售、挂单、接受交易或绕过 Steam 隐私。

## E. 发布判定

源码预发布必须同时满足：

1. A 类自动化门槛全部 `PASS`，Windows 与 Linux CI 均通过；
2. 至少一个目标桌面 Agent 完成 B 类干净 Clone 实机验收；
3. 发布说明中声称可用的核心数据源完成 C 类真实只读验收；
4. D 类安全边界全部通过；
5. `NOT_RUN`、`BLOCKED_EXTERNAL` 和 `NOT_APPLICABLE` 项在发布说明中如实披露。

正式稳定版还要求所有被宣传为“正式支持”的 Agent 完成各自实机验收。没有实机证据的客户端可以保留兼容配置，但不能标注为实机验证通过。

## 功能升级验收

每次升级先增加该功能的专项测试，再运行完整 `npm run acceptance:check`。只跑专项测试可用于开发迭代，不能用于公开发布。

### DIY 专项门槛

- 目录同步和补全保留 CSQAQ 来源与事实字段；
- 相同目录、偏好和约束产生确定性推荐；
- 推荐遵守预算、槽位、皮肤/贴纸兼容和数量限制；
- 只有 `render_diy_preview` 返回 `steamdt_game_render` 时才称为真实游戏渲染；
- `inspect_code_only` 只返回可复制检视代码，不伪造贴纸已经贴合枪身的图片；
- 只有用户明确评分或选择后才调用 `record_diy_feedback`；
- DIY 更新不得破坏行情、挂刀、库存、告警或其他 MCP 工具。

其他功能升级采用同一模式：专项正确性、数据来源、未知状态、副作用边界、向后兼容和全量回归缺一不可。

## 验收记录模板

```text
版本 / Commit：
日期：
系统 / Node.js：
Agent / 版本：

自动化发布门槛：PASS / FAIL
干净 Clone 自动启动：PASS / FAIL / NOT_RUN
Skill 与 MCP 自动发现：PASS / FAIL / NOT_RUN
health_check 与使用说明：PASS / FAIL / NOT_RUN
SteamDT 只读验收：PASS / FAIL / BLOCKED_EXTERNAL / NOT_APPLICABLE
CSQAQ 只读验收：PASS / FAIL / BLOCKED_EXTERNAL / NOT_APPLICABLE
公开 Steam 库存：PASS / FAIL / BLOCKED_EXTERNAL / NOT_APPLICABLE
企业微信通知：PASS / FAIL / NOT_RUN / NOT_APPLICABLE
秘密与副作用检查：PASS / FAIL

限制与未执行项：
最终判定：可发布 / 不可发布
```
