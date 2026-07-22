type ConfigurationHealth = Readonly<Record<string, unknown>>;

export function createMcpConfigurationGuide(health: ConfigurationHealth) {
  const steamDtConfigured = readConfigured(health, "steamDt");
  const csQaqConfigured = readConfigured(health, "csqaq");
  const steamProxyConfigured = readConfigured(health, "steamProxy");
  const wechatConfigured = readConfigured(health, "wechat");

  const nextActions = [
    steamDtConfigured
      ? "STEAMDT_API_KEY 已被当前 MCP 进程读取；可用一次只读行情查询验证当前权限。"
      : "如需 SteamDT 行情、K 线、综合决策和七日挂刀评估，请在本地 .env 填写 STEAMDT_API_KEY。",
    csQaqConfigured
      ? "CSQAQ_API_TOKEN 已被当前 MCP 进程读取；可用一次只读物品解析验证 Token、IP 绑定与当前权限。"
      : "如需 CSQAQ 持有人、供给、挂刀候选、武器箱、板块、汰换和 DIY 目录，请在本地 .env 填写 CSQAQ_API_TOKEN，并在提供方绑定当前公网 IP。",
    "修改 .env 后，在当前 Agent 客户端中重启或重新加载 cs2-item-agent MCP，再次调用 health_check；不要把密钥粘贴到对话中。",
  ];

  if (steamProxyConfigured) {
    nextActions.push("STEAM_PROXY_URL 已被读取，但连通性仍需通过一次不发送通知的公开库存查询验证。");
  }
  if (wechatConfigured) {
    nextActions.push("WECHAT_WEBHOOK_URL 已被读取，但不会自动发送测试消息；仅在用户明确要求时验证通知。");
  }

  return {
    envFile: ".env",
    envTemplate: ".env.example",
    secretHandling:
      "只在仓库根目录的本地 .env 中填写值。不要把 Key、Token、Webhook、Cookie 或带认证信息的代理地址写进 MCP 配置、聊天、截图、Issue 或 Git。",
    statusMeaning:
      "configured_unverified 只表示当前 MCP 进程读到了非空配置，不代表凭据有效、权限完整、额度可用或网络可达。",
    restartRequiredAfterChange: true,
    summary: {
      publicInventoryRequiresApiKey: false,
      configuredMarketProviderCount: Number(steamDtConfigured) + Number(csQaqConfigured),
      fullDataSourceExperienceConfigured: steamDtConfigured && csQaqConfigured,
      enterpriseWechatConfigured: wechatConfigured,
    },
    entries: [
      {
        variable: "STEAMDT_API_KEY",
        kind: "secret",
        priority: "recommended",
        status: steamDtConfigured ? "configured_unverified" : "not_configured",
        enables: ["SteamDT 行情与 K 线", "技术与综合决策", "七日挂刀评估", "SteamDT 检视预览"],
        setup: "打开仓库根目录的 .env，在 STEAMDT_API_KEY= 后填写自己的 Key，然后重启 MCP。",
        verification: {
          tool: "get_market_prices",
          sideEffect: "read_only_external_request",
          instruction: "对一个准确的 marketHashName 发起只读查询，并检查来源、观察时间和提供方错误。",
        },
      },
      {
        variable: "CSQAQ_API_TOKEN",
        kind: "secret",
        priority: "recommended_for_enhanced_data",
        status: csQaqConfigured ? "configured_unverified" : "not_configured",
        enables: ["监控样本内持有人与供给", "挂刀候选与武器箱", "板块与汰换目录", "贴纸 DIY 目录"],
        setup:
          "打开仓库根目录的 .env，在 CSQAQ_API_TOKEN= 后填写个人 Token，在 CSQAQ 绑定当前公网 IP，然后重启 MCP。",
        verification: {
          tool: "resolve_csqaq_item",
          sideEffect: "read_only_external_request",
          instruction: "先执行只读物品解析；认证、IP 绑定和具体接口权限仍以提供方本次响应为准。",
        },
      },
      {
        variable: "STEAM_PROXY_URL",
        kind: "sensitive_url",
        priority: "optional_when_steam_unreachable",
        status: steamProxyConfigured ? "configured_unverified" : "not_configured",
        enables: ["受限网络下访问 Steam Community 公开库存"],
        setup:
          "仅在无法直连 Steam Community 时填写本机 HTTP 代理，例如 http://127.0.0.1:7890，然后重启 MCP。",
        verification: {
          tool: "check_public_inventory",
          sideEffect: "external_request_and_local_snapshot",
          instruction: "使用获授权的公开 SteamID，并保持通知关闭；私密或失败必须报告为未知。",
        },
      },
      {
        variable: "WECHAT_WEBHOOK_URL",
        kind: "secret_url",
        priority: "optional_for_notifications",
        status: wechatConfigured ? "configured_unverified" : "not_configured",
        enables: ["企业微信告警和库存监控通知"],
        setup: "仅在需要企业微信通知时，将机器人 Webhook 填入本地 .env，然后重启 MCP。",
        verification: {
          tool: "test_enterprise_wechat",
          sideEffect: "sends_real_external_message",
          instruction: "该验证会真实发送消息，只有用户明确要求时才能调用。",
        },
      },
    ],
    nextActions,
  } as const;
}

function readConfigured(health: ConfigurationHealth, key: string): boolean {
  const section = health[key];
  return typeof section === "object" && section !== null &&
    "configured" in section && section.configured === true;
}
