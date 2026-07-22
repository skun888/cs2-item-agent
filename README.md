# CS2 Item Agent

CS2 Item Agent 是一个免费开源、本地优先、模型无关的 CS2 饰品市场与持仓决策助手。核心程序负责获取和计算可验证数据，Agent 负责基于证据解释结果，不执行自动交易，也不绕过 Steam 库存隐私设置。

当前已经完成阶段 8，并在其后补齐库存估值、用户自定义组合告警、可插拔行情适配器、CSQAQ 板块指数与 K 线、本地收藏品/稀有度/汰换关系目录，以及相互独立的行情交易与挂刀执行模型。专属 Skill 已覆盖全部 42 个 MCP 工具，并固化工具路由、证据等级、不确定性表达、副作用确认和跨 Agent 适配规范。

当前发布基线为 `0.8.0-alpha.1`：包含 42 个 MCP 工具、12 个 SQLite 迁移和 79 项自动化测试。Windows 与 Linux 均使用 Node.js 24 执行严格类型检查、构建、测试和带强制断言的 MCP 协议验收；该版本仍是源码预发布基线，不代表已经发布到 npm。

## Agent 项目接入

仓库已提交项目级 MCP 配置：Codex 读取 `.codex/config.toml`，Claude Code 与 Qoder 读取根目录 `.mcp.json`，Trae 读取 `.trae/mcp.json`，WorkBuddy 读取 `.workbuddy/mcp.json`。它们都通过相对路径启动同一个 `scripts/run-mcp.mjs`，不要求用户修改仓库路径，也不会把 API Key 写进客户端配置。首次打开仓库时，客户端可能要求信任项目、启用项目级 MCP 或批准本地命令，这是正常的安全确认。

`scripts/run-mcp.mjs` 是统一自动启动器。客户端首次启动它时会检查 Node.js 24、创建但绝不覆盖 `.env`、在缺少或锁文件更新时执行 `npm ci`、在构建缺失或源码更新时执行 `npm run build`、应用本地 SQLite 迁移，然后启动 MCP。准备过程只向 stderr 写日志，不会污染 stdio JSON-RPC。用户只需在生成的 `.env` 填写所需 API Key 并重启 MCP；如果客户端首次启动超时，可在仓库根目录手动运行一次 `npm run setup`。

Trae Windows 实机界面已确认项目级配置路径为 `.trae/mcp.json`；用户首次打开仓库时需要开启“启用项目级 MCP”，之后由 Trae 加载仓库配置并启动统一启动器。完整步骤见 [MCP 接入说明](./docs/MCP_SETUP.md)。

MCP 启动后不需要手动运行下面的 CLI 命令。用户可以直接在 Agent 对话中说“怎么开始”“我的 API Key 配置好了吗”“还缺什么配置”或提出具体的 CS2 饰品问题；Agent 会先调用 `health_check`，读取 MCP 自带的中文 `usageGuide`、动态 `configurationGuide`、当前配置状态、六类能力和安全示例，再选择相应工具。配置引导只显示变量名和 `configured_unverified` / `not_configured` 状态，不显示任何秘密；用户直接编辑本地 `.env` 并重启 MCP。CLI 仅供开发、排错和独立验证使用。

## 本地运行

要求 Node.js 24 或更高版本。

```bash
npm install
copy .env.example .env
npm run dev -- health
npm run dev -- provider list
npm run dev -- provider audit csqaq
npm run dev -- db migrate
npm run dev -- market price "Danger Zone Case"
npm run dev -- market compare "Danger Zone Case"
npm run dev -- market analyze "Danger Zone Case" --platform STEAM --type 1
npm run dev -- market trade "M4A1-S | Nightmare (Factory New)" --platform STEAM --type 1 --context-file examples/market-trading-context.example.json
npm run dev -- sector list
npm run dev -- sector kline thousand_weapon --interval 1day
npm run dev -- collection sync --search 核子危机 --limit 3
npm run dev -- collection analyze 核子花园
npm run dev -- market decide "M4A4 | Hellfire (Factory New)" --platform STEAM --type 1
npm run dev -- csqaq holders "M4A4 | Hellfire (Factory New)" --limit 10
npm run dev -- csqaq supply "M4A4 | Hellfire (Factory New)"
npm run dev -- hanging screen --target steam --source BUFF --steam-exit highest_bid --min-price 1 --max-price 500 --turnover 10 --limit 20
npm run dev -- hanging screen --target platform --source BUFF --steam-buy listing --platform-exit highest_bid --min-price 1 --max-price 500 --turnover 10 --limit 20
npm run dev -- hanging assess "AUG | Ricochet (Field-Tested)" --target platform --source BUFF --steam-buy listing --platform-exit highest_bid --platform STEAM --type 1 --min-price 1 --max-price 500 --turnover 10
npm run dev -- inventory check 7656119XXXXXXXXXX
npm run dev -- inventory show 7656119XXXXXXXXXX --item "M4A4 | Hellfire (Factory New)"
npm run dev -- inventory valuation 7656119XXXXXXXXXX
npm run dev -- inventory holders "M4A4 | Hellfire (Factory New)"
npm run dev -- inventory watch add 7656119XXXXXXXXXX --label "本地示例" --interval 30
npm run dev -- inventory watch run --once
npm run dev -- alert rule add "Danger Zone Case" --platform BUFF --metric sell_price --operator lt --threshold 8 --provider any --cooldown 60
npm run dev -- alert rule list
npm run dev -- alert combo preview --file examples/composite-alert-rule.example.json
npm run dev -- alert combo add --file examples/composite-alert-rule.example.json
npm run dev -- alert combo list
npm run dev -- alert run --once
npm run dev -- diy catalog sync "AK-47 | Slate" --pages 1 --page-size 20
npm run dev -- diy catalog enrich "AK-47 | Slate (Factory New)" --kind skin --limit 1
npm run dev -- diy recommend "AK-47 | Slate (Factory New)" --style black_gold --budget 100 --slots 4
npm run dev -- diy preview 1
npm run dev -- diy inspect "csgo_econ_action_preview 00..."
npm run dev -- diy decode "csgo_econ_action_preview 00..."
npm run build
npm run mcp
npm run release:verify
```

macOS/Linux 可用 `cp .env.example .env`。只有调用 SteamDT 行情的命令需要填写 `STEAMDT_API_KEY`；读取公开 Steam 库存不需要 Steam 密码、Cookie 或 Publisher Key。企业微信通知需要本地填写 `WECHAT_WEBHOOK_URL`。

CSQAQ 是可选增强数据源。个人用户在本地 `.env` 填写 `CSQAQ_API_TOKEN` 并绑定当前公网 IP 后，可运行 `provider audit csqaq` 生成脱敏权限报告。项目不会保存审计响应中的 SteamID、昵称、头像或持仓明细；具体说明见 [CSQAQ 个人权限审计](./docs/CSQAQ_AUDIT.md)。

`provider list` 和 MCP `health_check` 会列出所有已注册市场适配器、是否配置、能力、覆盖平台、批量限制和优先级，但不会显示 Key。`market compare` 与 `compare_market_prices` 会调用全部已配置的行情适配器；相同平台的数据按来源和观察时间分别保存，单个来源失败不会抹掉其他结果，只有至少两个来源提供有效价格时才计算差异率。

当前内置 SteamDT 与 CSQAQ 适配器。BUFF、悠悠有品、C5 等授权接口不猜测私有字段；取得合法文档和脱敏响应后，只需实现统一行情协议并在工厂注册，不需要修改行情比较、库存估值、告警或 MCP 上层。扩展契约、模板与安全要求见 [可插拔平台适配器](./docs/PLATFORM_ADAPTERS.md)。

如果当前网络无法直连 `steamcommunity.com`，可在 `.env` 设置本地 HTTP 代理，例如 `STEAM_PROXY_URL=http://127.0.0.1:7890`。代理地址只用于 Steam 库存请求，健康检查不会显示其具体值。

`inventory watch run` 会持续运行，只检查已到期的任务；`--once` 会立即检查全部已启用任务一次。首次成功库存快照只建立基线，不会把账号已有库存全部标为新增。

配置带有 BUFF 批量报价能力的适配器后，每份完整公开库存快照还会生成 BUFF 基础类目估值；默认按注册优先级选定一个来源，绝不在同一次估值中静默混价。缺价不按 0 元计算；输出价格覆盖率，并把库存构成变化与市场价格变化拆开。单件基础价不低于 ¥1,000 只记录高价值物品事件；只有库存构成估值变化同时达到 ¥10,000 和 20%，且前后价格覆盖率均不低于 90%，才标记为高价值库存异动。特殊模板、极限磨损和贴纸溢价不在估值内。详细说明见 [库存估值与高价值异动](./docs/INVENTORY_VALUATION.md)。

`alert run` 按 `ALERT_DEFAULT_INTERVAL_MINUTES` 持续评估单条件与组合规则，默认 30 分钟；`--once` 只执行一次。组合规则支持 `AND/OR`、市场当前值、30分钟至7天的本地变化率、公开库存事件、估值与高价值事件。先执行 `combo preview`，由用户确认标准化结果后再 `combo add`。未知数据不触发，跨条件证据默认最多相差30分钟。`alert test wechat` 会真实发送测试消息。详细规则见 [告警与企业微信](./docs/ALERTS_AND_WECHAT.md)。

阶段 5 的数据覆盖、缓存、费率模板、七日情景公式与两套模型边界见 [数据能力、市场分析与挂刀评估](./docs/MARKET_ANALYSIS_AND_HANGING.md)。`market_trading` 负责板块、有效流通盘、大商属性和汰换关系；`hanging_execution` 只负责七日保护后的兑换与退出风险。挂刀标签只表示是否通过当前模板阈值，Steam 余额比例不是现金利润率。

阶段 6 的 MCP 工具路由、自然语言回答规范和副作用边界见 [自然语言 Agent 工作流](./docs/AGENT_WORKFLOW.md)。项目适用于任何能够启动本地 stdio MCP 的客户端，并不只限于 Codex、Qoder 和 Trae。

阶段 8 的专属 Skill 以 [`.agents/skills/cs2-item-agent`](./.agents/skills/cs2-item-agent/SKILL.md) 为唯一权威来源。Skill 负责教 Agent 正确选择工具和解释证据，不生成行情或库存事实；详细市场、挂刀、库存和 DIY 规范按需保存在其 `references/` 目录。`skills/` 与 `.claude/skills/` 中只保存自动生成的客户端适配入口，运行 `npm run skill:sync` 更新，`npm run skill:check` 检查一致性。

阶段 7 的目录来源、审美规则、真实检视代码、渲染边界和反馈闭环见 [饰品 DIY](./docs/DIY.md)。旧版通用坐标 SVG 已弃用；上游没有返回游戏渲染图时，程序只提供可复制到 CS2 的检视代码，不伪造贴纸已经贴合枪身的图片。

Steam 新版物品证书、SteamDT v1/v2 与自定义 DIY code 的脱敏真实验收见 [Steam 与 SteamDT 检视图真实能力审计](./docs/STEAMDT_INSPECT_AUDIT.md)。

## 安全边界

- Key、Webhook、真实 SteamID 与本地数据库不会提交到仓库。
- 示例和固定测试数据必须虚构或脱敏。
- 市场输出必须保留来源、观察时间与限制说明。
- 私密、好友可见、限流或临时失败的库存属于未知状态，绝不会被当作空库存。
- 本地持有人排行只覆盖用户自己加入监控并成功取得快照的账号，不代表全网排行。
- CSQAQ 的库存和持有人数据只代表其监控覆盖范围；企业接口不属于免费版默认能力。
- 本项目只辅助研究和决策，不构成投资建议，不自动买卖饰品。

详细设计见 [PROJECT_PLAN.md](./PROJECT_PLAN.md)。

发布与功能升级统一执行 `npm run acceptance:check`；自动化、干净 Clone 实机、真实只读数据源和安全副作用的判定规则见 [发布与功能升级验收标准](./docs/RELEASE_ACCEPTANCE.md)。

Codex、Claude Code、Qoder、Trae 和 WorkBuddy 的 MCP 接入方式见 [docs/MCP_SETUP.md](./docs/MCP_SETUP.md)。
