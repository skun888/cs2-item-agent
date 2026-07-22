# 本地 MCP 接入

CS2 Item Agent 使用本地 `stdio` MCP。所有客户端都启动同一个 `scripts/run-mcp.mjs`，启动器会自动切换到仓库目录，再由核心读取本地 `.env`。不要把 SteamDT、CSQAQ Key 或企业微信 Webhook 写进 MCP 配置。

## 自动准备

只需预先安装 Node.js 24 或更高版本。项目级 MCP 客户端启动 `scripts/run-mcp.mjs` 后会自动：

1. 检查 Node.js 主版本；启动器本身依赖 Node.js，因此不会尝试替用户安装运行时；
2. 从 `.env.example` 创建本地 `.env`，已有 `.env` 永远不会被覆盖；
3. 缺少依赖或 `package-lock.json` 更新时运行 `npm ci --no-audit --no-fund`；
4. 缺少构建产物或 `src/**/*.ts`、包清单、TypeScript 配置更新时运行 `npm run build`；
5. 串行执行 12 个幂等 SQLite 迁移；
6. 启动本地 stdio MCP。

首次安装需要访问 npm registry，可能超过某些客户端的默认 MCP 等待时间。遇到超时时，在仓库根目录先运行一次：

```powershell
npm run setup
```

该命令只做准备和迁移，不常驻启动 MCP。准备完成后重启客户端 MCP 即可。

如需行情、综合决策和七日情景，确认 `.env` 中已配置 `STEAMDT_API_KEY`；CSQAQ 持有人、存世量、武器箱和挂刀候选需要 `CSQAQ_API_TOKEN`。公开库存工具本身不需要这两个 Key。项目级配置已经使用仓库相对路径，不需要用户修改安装目录；Node.js 必须能够通过系统 `PATH` 中的 `node` 命令启动。

国内网络若无法直连 Steam Community，可在 `.env` 增加：

```text
STEAM_PROXY_URL=http://127.0.0.1:7890
```

端口按用户本地代理软件修改。不要把带认证信息的代理地址写入 MCP 配置或提交到仓库。

## 已提交的项目级配置

| 客户端 | 仓库配置 | 打开项目后的行为 |
| --- | --- | --- |
| Codex | `.codex/config.toml` | 在可信项目中发现 `cs2_item_agent` 并启动本地 stdio 服务；可用 `/mcp` 检查状态 |
| Claude Code | `.mcp.json` | 发现项目作用域的 `cs2-item-agent`；首次使用需批准项目 MCP |
| Qoder | `.mcp.json` | 发现项目作用域的 `cs2-item-agent`；已有会话可用 `/mcp reload` 重新加载 |
| WorkBuddy | `.workbuddy/mcp.json` | 打开项目后读取项目 MCP 配置并启动同一服务 |

这些配置负责发现统一启动器，启动器负责准备依赖、构建、迁移和启动 MCP。客户端要求“信任项目”“批准 MCP”属于本地命令执行的安全边界，项目不能也不应该绕过。Codex 的项目配置为首次安装保留 300 秒启动时间；其他客户端若提前超时，可使用上面的 `npm run setup` 预热。

对应官方说明：[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp)、[Claude Code MCP](https://code.claude.com/docs/en/mcp)、[Qoder MCP Servers](https://docs.qoder.com/en/cli/mcp-servers)、[WorkBuddy MCP 指南](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide)。

## Trae

Trae 官方页面已确认支持 project-level MCP server，但没有给出一个可提交到仓库、由客户端自动读取的配置文件路径，本项目也尚未完成真实 Trae 客户端验收。为避免提交一个客户端不会读取的猜测文件，当前保留手动导入：

- 打开 Trae 的 MCP 管理页面；
- 导入或参考 `examples/mcp/trae.mcp.json`；
- 把其中 `ABSOLUTE_PATH_TO_REPOSITORY` 替换为本机仓库绝对路径；
- Name 保持 `cs2-item-agent`，Command 保持 `node`。

配置文件路径确认并通过真实客户端验收后，再把 Trae 纳入 Clone 后自动发现基线。参考：[Trae MCP 文档](https://docs.trae.ai/ide/model-context-protocol)、[Trae 更新日志](https://www.trae.ai/changelog)。

## 其他 MCP 客户端

项目并不只支持上述客户端。任何能够启动本地 stdio MCP、接受 `command + args` 的 Agent 都能使用同一个核心，可参考 `examples/mcp/generic.stdio.json`。如果客户端支持仓库相对路径，可直接使用示例；否则只需把脚本改为本机绝对路径。项目只为 Codex、Claude Code、Qoder、WorkBuddy 和 Trae 维护专门适配，其他客户端不再增加专属核心或目录。

## 工具

当前共提供 42 个工具，包括独立行情交易模型、挂刀执行模型、板块指数与 K 线、本地收藏品/汰换关系，以及组合告警的预览、确认创建、列表和启停工具。

市场与自然语言决策：

- `get_market_prices`、`compare_market_prices`、`get_market_kline`；
- `analyze_market_item`：基础确定性市场分析；
- `analyze_market_trading`：行情交易首选入口，组合市场、板块、有效流通盘、监控覆盖和汰换上下游；
- `analyze_item_decision`：`analyze_market_trading` 的兼容别名。

CSQAQ 数据能力：

- `resolve_csqaq_item`；
- `get_csqaq_holder_ranking`；
- `get_csqaq_supply_trend`；
- `get_case_market_overview`；
- `list_market_sectors`：刷新并列出 CSQAQ 板块指数，同时保存当日 Steam 卡价；
- `get_sector_kline`：查询指定板块 K 线和匹配窗口的涨跌表现；
- `sync_tradeup_catalog`：按搜索词和数量上限同步收藏品、稀有度与成员到本地 SQLite；
- `analyze_tradeup_relationship`：查询本地同级、相邻上级、合同投入件数和汰换资格。

挂刀：

- `show_hanging_fee_assumptions`；
- `screen_hanging_candidates`；
- `assess_hanging_candidate`。

行情与挂刀工具不共享最终评分。需要同时回答时必须分别调用并给出两个结论。

公开库存：

- `check_public_inventory`、`query_latest_inventory`、`query_latest_inventory_valuation`、`rank_local_inventory_holders`；
- `add_inventory_watch`、`list_inventory_watches`、`disable_inventory_watch`、`run_inventory_watches_once`。

告警与通知：

- `add_market_alert`、`list_alert_rules`、`set_alert_rule_enabled`、`run_alert_rules_once`；
- `preview_composite_alert_rule`、`add_composite_alert_rule`、`list_composite_alert_rules`、`set_composite_alert_rule_enabled`；
- `test_enterprise_wechat` 会真实发送消息，只有用户明确要求时才调用。

饰品 DIY：

- `sync_diy_catalog`、`enrich_diy_catalog`、`search_diy_catalog`；
- `recommend_diy_loadouts`、`render_diy_preview`；
- `record_diy_feedback`、`get_diy_preferences`。

DIY 的目录同步和补全会读取 CSQAQ 并写入本地缓存；推荐、预览与反馈只改动本地数据。详细边界见 [DIY.md](./DIY.md)。

完整的自然语言路由和回答规范见 [AGENT_WORKFLOW.md](./AGENT_WORKFLOW.md)。

所有工具只读取公开外部数据并写入用户本地观察数据库，不执行购买、出售、挂单或交易。库存不可见、限流或失败时不会生成移除事件。本地持有人排行不是全网排行。

## 排错

1. Node.js 版本错误时安装或切换到 Node.js 24，再重新打开项目；
2. `npm ci` 失败时检查 npm registry、代理和网络，再运行 `npm run setup`；
3. 填写新生成的 `.env` 后必须重启 MCP，正在运行的进程不会热加载 Key；
4. 直接执行 `node scripts/run-mcp.mjs` 时只有 stderr 准备日志、没有普通 stdout 是正常现象，stdio 正在等待 MCP 客户端消息；
5. MCP 服务器与自动启动器不得向 stdout 打印诊断日志，否则会破坏 JSON-RPC；
6. 项目级配置不要改成用户专属绝对路径；只有 Trae 当前手动导入示例需要替换绝对路径，JSON 中的反斜杠写成 `\\`；
7. 运行 `npm run mcp:config:check` 可检查已提交配置是否仍然无密钥、无绝对路径并统一使用共享启动器。
