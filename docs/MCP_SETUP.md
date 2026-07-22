# 本地 MCP 接入

CS2 Item Agent 使用本地 `stdio` MCP。MCP 客户端启动 `scripts/run-mcp.mjs`，启动器会自动切换到仓库目录，再由核心读取本地 `.env`。不要把 SteamDT 或 CSQAQ Key 写进 MCP 配置。

## 准备

在仓库根目录运行：

```powershell
npm install
npm run build
npm run dev -- health
```

如需行情、综合决策和七日情景，确认 `.env` 中已配置 `STEAMDT_API_KEY`；CSQAQ 持有人、存世量、武器箱和挂刀候选需要 `CSQAQ_API_TOKEN`。公开库存工具本身不需要这两个 Key。MCP 配置中的脚本路径必须改成用户电脑上的绝对路径。

国内网络若无法直连 Steam Community，可在 `.env` 增加：

```text
STEAM_PROXY_URL=http://127.0.0.1:7890
```

端口按用户本地代理软件修改。不要把带认证信息的代理地址写入 MCP 配置或提交到仓库。

## Codex

Codex、ChatGPT 桌面端和 Codex IDE 扩展共享同一份本地 MCP 配置。可以在设置中的 MCP servers 页面添加 STDIO 服务，也可以使用 CLI：

```powershell
codex mcp add cs2-item-agent -- node "C:\绝对路径\cs2-item-agent\scripts\run-mcp.mjs"
```

也可以把 `examples/mcp/codex.config.toml` 中的配置复制到用户级 `~/.codex/config.toml`，或可信仓库的 `.codex/config.toml`。保存后重启 MCP 服务或客户端，再用 `/mcp` 查看连接状态。

## Qoder

Qoder CLI 可以运行：

```powershell
qodercli mcp add cs2-item-agent -- node "C:\绝对路径\cs2-item-agent\scripts\run-mcp.mjs"
```

Qoder IDE 可以打开 Settings → MCP → My Servers，添加 STDIO 服务，并参考 `examples/mcp/qoder.mcp.json`。已有会话中修改配置后，重新加载 MCP 或新建会话。

## Trae

在 Trae 的 MCP 管理页面手动添加 STDIO 服务：

- Name：`cs2-item-agent`
- Command：`node`
- Args：本地 `scripts/run-mcp.mjs` 的绝对路径

也可以参考 `examples/mcp/trae.mcp.json`。不同 Trae 版本的设置入口可能变化，应以当前官方 MCP 页面为准。

## 其他 MCP 客户端

项目并不只支持上述三个客户端。任何能够启动本地 stdio MCP、接受 `command + args` 的 Agent 都能使用同一个核心，可参考 `examples/mcp/generic.stdio.json`。Cursor、Cline、Windsurf 等客户端只需要把脚本绝对路径填入各自 MCP 设置；具体设置入口以客户端当前版本为准。

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

1. 先运行 `npm run build`；
2. 再运行 `npm run dev -- health`；
3. 直接执行 `node scripts/run-mcp.mjs` 时没有普通终端输出是正常现象，stdio 正在等待 MCP 客户端消息；
4. MCP 服务器不得向 stdout 打印日志，否则会破坏 JSON-RPC；诊断信息只能进入 stderr；
5. Windows 路径必须使用绝对路径；JSON 中的反斜杠需要写成 `\\`。
