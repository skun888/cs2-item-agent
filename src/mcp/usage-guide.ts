export const MCP_USAGE_GUIDE = {
  language: "zh-CN",
  purpose:
    "这是一个本地优先的 CS2 饰品市场与持仓决策助手。它负责读取实时或本地证据并执行确定性计算，不会替用户自动交易。",
  startHere: [
    "先根据本次 health_check 的 configured 状态判断可用数据源；未配置或请求失败的数据必须视为未知。",
    "用户可以直接用自然语言提问，Agent 应选择最窄、只读且足够回答问题的工具。",
    "只有用户明确要求创建或运行监控、告警、通知时，才调用可能产生本地状态或外部消息的工具。",
  ],
  capabilityGroups: [
    { name: "行情与决策", description: "查询和比较价格、K 线，并基于当前证据分析市场与饰品。" },
    { name: "持有人与供给", description: "分析 CSQAQ 监控覆盖内的持有人、存世趋势、武器箱和板块数据。" },
    { name: "公开库存", description: "读取公开 Steam 库存、保存本地快照并分析库存变化与基础估值。" },
    { name: "挂刀评估", description: "按明确的余额目标、手续费和七日情景筛选与评估候选品。" },
    { name: "监控与告警", description: "在用户明确要求后创建本地库存监控、价格告警和可选通知。" },
    { name: "贴纸 DIY", description: "同步目录、推荐贴纸搭配、生成真实可用的预览或检视代码并记录明确反馈。" },
  ],
  safeExamplePrompts: [
    {
      prompt: "比较 M4A4 | Hellfire (Factory New) 当前各平台价格，并说明来源和观察时间。",
      route: "compare_market_prices",
    },
    {
      prompt: "分析 Danger Zone Case 最近行情，只给证据、风险和不确定性，不要替我交易。",
      route: "analyze_market_trading",
    },
    {
      prompt: "查看 7656119xxxxxxxxxx 的公开库存；如果不可见就报告未知，不要发送通知。",
      route: "check_public_inventory",
    },
    {
      prompt: "先展示当前挂刀手续费假设，不要创建告警或执行任何交易。",
      route: "show_hanging_fee_assumptions",
    },
    {
      prompt: "为 AK-47 | Slate 推荐贴纸搭配，不记录偏好。",
      route: "recommend_diy_loadouts",
    },
  ],
  responseRules: [
    "保留来源、观察时间、覆盖范围、手续费假设和限制说明。",
    "区分已验证观察、确定性计算、有条件解释和未知，不把挂单价当成交价。",
    "不得承诺收益、预测必然涨跌、执行购买出售或索取密钥、Cookie、密码。",
  ],
  sideEffects: {
    readOnlyAnalysis: "可在用户提问后直接执行。",
    localState:
      "创建、启停或运行库存监控和告警必须符合用户明确意图；组合告警必须先预览，再经用户确认创建。",
    externalMessages:
      "test_enterprise_wechat、run_alert_rules_once、run_inventory_watches_once，以及启用通知的库存检查可能发送消息，调用前必须确认用户意图。",
    trading: "不提供下单、挂单、出售或接受交易能力。",
  },
  configurationReminder:
    "密钥只保存在仓库根目录的本地 .env 中，绝不写入 MCP 配置或对话；修改 .env 后需要重启 MCP。",
} as const;
