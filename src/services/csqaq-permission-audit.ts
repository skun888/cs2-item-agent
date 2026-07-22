import { CsQaqClient } from "../adapters/csqaq/client.js";
import type {
  CsQaqAuditProbeResult,
  CsQaqAuditStatus,
  CsQaqPermissionAuditReport,
  CsQaqProbeSpec,
} from "../adapters/csqaq/types.js";

export const CSQAQ_AUDIT_MINIMUM_INTERVAL_MS = 1_100;

const PROBES: readonly CsQaqProbeSpec[] = [
  {
    id: "batch_prices",
    label: "批量饰品出售价格",
    documentedTier: "personal",
    method: "POST",
    path: "/api/v1/goods/getPriceByMarketHashName",
    body: { marketHashNameList: ["Danger Zone Case"] },
  },
  {
    id: "survival_trend",
    label: "单件饰品近180天存世量走势",
    documentedTier: "personal",
    method: "GET",
    path: "/api/v1/info/good/statistic",
    query: { id: "7310" },
  },
  {
    id: "hanging_candidates",
    label: "挂刀行情候选",
    documentedTier: "personal",
    method: "POST",
    path: "/api/v1/info/exchange_detail",
    body: {
      page_index: 1,
      res: 0,
      platforms: "BUFF-YYYP",
      sort_by: 1,
      min_price: 1,
      max_price: 5000,
      turnover: 10,
    },
    note: "候选与平台公式仅作为数据源，项目仍需使用用户费率模板自行复算。",
  },
  {
    id: "case_counts",
    label: "武器箱开箱数量统计",
    documentedTier: "personal",
    method: "GET",
    path: "/api/v1/stat/case",
  },
  {
    id: "case_roi",
    label: "武器箱与胶囊回报率",
    documentedTier: "personal",
    method: "POST",
    path: "/api/v1/info/roi",
  },
  {
    id: "monitor_tasks",
    label: "库存监控任务列表",
    documentedTier: "unclear",
    method: "POST",
    path: "/api/v1/monitor/get_task_list",
    body: { page_index: 1, page_size: 1, order: "HOT", search: "" },
    note: "只汇总响应结构，不保存或输出 SteamID、昵称、头像和持仓内容。",
  },
  {
    id: "monitor_trends",
    label: "库存监控最新动态",
    documentedTier: "unclear",
    method: "POST",
    path: "/api/v1/monitor/get_task_trends",
    body: { page_index: 1, page_size: 1 },
    note: "只汇总响应结构，不保存或输出账号及饰品明细。",
  },
  {
    id: "holder_ranking",
    label: "单件饰品持有量排行榜",
    documentedTier: "unclear",
    method: "POST",
    path: "/api/v1/monitor/rank",
    body: { good_id: "8581" },
    note: "用户反馈该能力可能需要企业权限；审计结果以个人 Token 的真实响应为准。",
  },
];

export async function auditCsQaqPersonalPermissions(
  client: CsQaqClient,
  options: { readonly delay?: (milliseconds: number) => Promise<void>; readonly now?: () => Date } = {},
): Promise<CsQaqPermissionAuditReport> {
  const delay = options.delay ?? wait;
  const now = options.now ?? (() => new Date());
  const probes: CsQaqAuditProbeResult[] = [];

  for (const [index, probe] of PROBES.entries()) {
    if (index > 0) await delay(CSQAQ_AUDIT_MINIMUM_INTERVAL_MS);
    probes.push(await client.auditProbe(probe));
  }

  probes.push({
    id: "enterprise_bulk_catalog",
    label: "企业全量饰品ID与价格",
    documentedTier: "enterprise",
    status: "not_probed",
    requestedAt: now().toISOString(),
    durationMs: 0,
    dataShape: { kind: "missing", fields: [] },
    note: "官方明确标记为企业接口且响应体很大，个人审计不发送该请求。",
  });
  probes.push({
    id: "paused_transaction_data",
    label: "实时成交与磨损数据",
    documentedTier: "unclear",
    status: "not_probed",
    requestedAt: now().toISOString(),
    durationMs: 0,
    dataShape: { kind: "missing", fields: [] },
    note: "官方文档标记为暂停更新，审计不把旧数据误判为可用能力。",
  });

  return {
    schemaVersion: 1,
    provider: "csqaq",
    auditedAt: now().toISOString(),
    baseUrl: client.baseUrl,
    minimumRequestIntervalMs: CSQAQ_AUDIT_MINIMUM_INTERVAL_MS,
    limitations: [
      "报告只包含状态、数量和字段名，不包含 Token、SteamID、昵称、头像或持仓明细。",
      "available 仅证明当前个人 Token 在本次审计时可调用，不保证未来额度、条款或字段不变。",
      "CSQAQ 库存和持有人数据仅代表其监控覆盖范围，不能表述为 Steam 全网。",
      "未自动修改白名单 IP；若返回 configuration_required，需由用户在 CSQAQ 完成绑定后重试。",
    ],
    summary: summarizeStatuses(probes),
    probes,
  };
}

function summarizeStatuses(
  probes: readonly CsQaqAuditProbeResult[],
): Readonly<Record<CsQaqAuditStatus, number>> {
  const statuses: readonly CsQaqAuditStatus[] = [
    "available",
    "authentication_failed",
    "configuration_required",
    "permission_denied",
    "contract_rejected",
    "rate_limited",
    "provider_rejected",
    "unavailable",
    "network_error",
    "not_probed",
  ];
  return Object.fromEntries(
    statuses.map((status) => [status, probes.filter((probe) => probe.status === status).length]),
  ) as Readonly<Record<CsQaqAuditStatus, number>>;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
