# 自然语言 Agent 工作流

CS2 Item Agent 不内置云模型。Codex、Qoder、Trae、Cursor、Cline、Windsurf 或其他支持本地 stdio MCP 的客户端负责理解用户问题；本项目的 MCP 负责获取事实、运行确定性计算并返回可解释报告。

阶段 8 后，`.agents/skills/cs2-item-agent/SKILL.md` 是模型侧工具路由与表达规范的唯一权威来源，`references/` 按需提供双模型路由、市场方法、挂刀情景、库存覆盖、DIY 和证据政策。客户端专用 Skill 路径只保存自动生成的适配入口。MCP 仍是唯一事实与计算执行层；Skill 或知识库不能替代实时接口结果。

## 推荐路由

| 用户问题 | 首选工具 | 必要后续工具 |
| --- | --- | --- |
| “这件饰品的行情、大商属性或汰换逻辑怎么看？” | `analyze_market_trading` | 只把用户确认内容放入 `expertContext` |
| “这件饰品适合挂刀吗？” | `screen_hanging_candidates` / `assess_hanging_candidate` | 不使用行情模型代替挂刀结论 |
| “谁持有地狱烈焰最多？” | `get_csqaq_holder_ranking` | 说明仅为 CSQAQ 监控范围 |
| “存世量最近有没有变化？” | `get_csqaq_supply_trend` | 默认最近 10 点；确需序列时请求全部点 |
| “今天有什么挂刀候选？” | `screen_hanging_candidates` | 对选中的精确名称调用 `assess_hanging_candidate` |
| “这个候选七天后风险如何？” | `assess_hanging_candidate` | 先用相同筛选条件确认候选存在 |
| “当前实际采用什么手续费？” | `show_hanging_fee_assumptions` | 修改本地模板后重新启动 MCP |
| “某武器箱开箱数据如何？” | `get_case_market_overview` | 回报率只能称为提供方期望值 |
| “这个公开 SteamID 有什么变化？” | `check_public_inventory` | 再用 `query_latest_inventory` 查询明细 |
| “这个库存值多少钱、是不是大额转入？” | `query_latest_inventory_valuation` | 需要当前状态时先执行 `check_public_inventory` |
| “价格低于2000且在售量24小时下降20%时提醒我” | `preview_composite_alert_rule` | 展示标准化规则；用户确认后调用 `add_composite_alert_rule` |
| “AK-47 墨岩怎么贴好看？” | `search_diy_catalog` | 缺目录时经用户同意同步/补全，再调用 `recommend_diy_loadouts` 与 `render_diy_preview` |

## 行情交易模型

`analyze_market_trading` 顺序组合：

1. SteamDT 当前多平台行情、K 线和可选大盘；
2. CSQAQ 监控范围持有人集中度；
3. CSQAQ 近 180 天存世量摘要；
4. 可选的板块、有效流通盘、大商属性和汰换关系专家上下文；
5. 固定规则分别生成已验证观察、确定性计算、专家标注、支持信号、风险信号、未知和判断失效条件。

该模型只回答行情交易，不回答七日保护后的挂刀可执行性。`analyze_item_decision` 是兼容别名，新工作流优先使用明确工具名。

CSQAQ 未配置或单个增强接口失败时，SteamDT 市场分析仍可返回；失败部分明确标记 `not_configured` 或 `unavailable`。模型不得用常识或旧记忆填充这些缺失字段。

## Agent 回答规范

自然语言回答建议固定为：

```text
结论：当前证据支持什么、不支持什么。
关键数据：价格、数量、时间窗口、费率和覆盖范围。
支持信号：由规则计算得到的正向证据。
风险信号：波动、供给、集中度、流动性或数据质量风险。
未知：接口未提供、库存不可见、真实成交量或未来信息。
证据：source + observedAt。
置信度：描述数据完整度，不是预测命中概率。
```

Agent 必须遵守：

- CSQAQ 排行只能称为“CSQAQ 已监控公开账号样本内排行”；
- 本地库存排行只能称为“用户本地监控覆盖排行”；
- 公开库存中消失不等于卖出；
- 库存估值必须说明 BUFF 基础类目口径和价格覆盖率；市场涨跌影响不能称为库存转入或转出；
- Steam 余额比例不等于人民币现金利润率；
- 七日结果只能称为防守、基础和乐观情景；
- 不输出“稳赚、必涨、无风险套利、全网持有人已完整覆盖”；
- 不自动调用企业微信测试、启用监控或创建告警，除非用户明确要求对应副作用。
- 组合告警必须先预览；展示 `AND/OR`、窗口、阈值、连续命中、冷却、恢复通知和证据时间差，用户确认后才能保存。未知条件不转换成“不满足”。
- DIY 商品字段与价格是数据源事实；颜色标签、风格评分和布局是本地规则推导，回答时必须区分。
- DIY 只有在 `render_diy_preview.mode=steamdt_game_render` 时才可称为游戏渲染图；`inspect_code_only` 只能返回真实检视代码和限制说明，不得用通用坐标叠图冒充贴合效果，也不得替用户虚构审美反馈。

## 示例对话

用户：

```text
M4A4 | 地狱烈焰（崭新出厂）现在适合关注吗？大户集中度怎么样？
```

Agent 应调用 `analyze_market_trading`，并基于工具返回值组织答案。若中文名称产生歧义，先调用 `resolve_csqaq_item` 或要求用户确认精确 `marketHashName`。用户补充的板块截图、有效流通盘或大商经验必须保留为专家上下文，不得改写成 API 事实。

用户：

```text
从 BUFF 买入、七天后丢 Steam 求购，帮我找 100 元以内的候选。
```

该表述已经明确目标是获得 Steam 余额；如果用户只说“帮我挂刀”，Agent 必须先询问想获得 Steam 余额还是平台余额，不能自行推断。确认本例路径后，Agent 先调用 `show_hanging_fee_assumptions`，再调用：

```text
screen_hanging_candidates(
  targetBalance="steam",
  sourcePlatform="BUFF",
  steamExitMode="highest_bid",
  maximumPrice=100
)
```

然后只对用户选中或少量排名靠前的精确候选调用 `assess_hanging_candidate`，并继续传入相同的 `targetBalance="steam"`、来源平台和退出模式。不能把当前价差直接称为七天后收益，也不能与“获得平台余额”路径的比例混合排序。

## 副作用边界

行情、持有人、存世量、武器箱和挂刀工具只读取外部公开/授权数据，并可能追加本地缓存或报告。

以下工具会改变本地状态或可能向外发送消息：

- 创建、启停告警规则；
- 添加、停用或执行库存监控；
- `test_enterprise_wechat`；
- 会触发新阈值的 `run_alert_rules_once`。

Agent 在用户只要求分析时不得擅自调用这些工具。

## 跨 Agent 使用

- Codex 可直接加载仓库内的 `cs2-item-agent` Skill；
- 支持项目规则但不原生识别 Skill 的客户端，可把 `SKILL.md` 和当前问题需要的一份 `references/*.md` 作为项目指令；
- 所有客户端继续连接同一个本地 stdio MCP，不为不同模型复制行情、数据库或计算逻辑；
- 如果客户端没有发现某个 MCP 工具，应先检查 MCP 配置和 `health_check`，不得根据 Skill 文本模拟一个不存在的接口结果。
