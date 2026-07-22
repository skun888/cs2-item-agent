# 告警规则与企业微信通知

阶段 4 提供本地、数据源无关的告警层。任意一个行情适配器配置后即可运行；多源配置时分别保留报价，并可让规则限定稳定适配器 ID。

## 企业微信配置与测试

Webhook 只保存在被 Git 忽略的 `.env`：

```dotenv
WECHAT_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=你的Key
```

手动测试：

```bash
npm run dev -- alert test wechat
```

该命令会产生真实外部消息，内容会明确写明“测试”，不会伪装成市场或库存变化。普通构建、测试、健康检查和规则列表不会发送消息。

发送失败默认最多尝试三次，等待时间按 500ms、1000ms 递增。最终状态和尝试次数保存在本地 SQLite，Webhook 本身不会进入日志和数据库。

## 市场规则

示例：BUFF 最低在售价低于 8 元时告警。

```bash
npm run dev -- alert rule add "Danger Zone Case" \
  --platform BUFF \
  --metric sell_price \
  --operator lt \
  --threshold 8 \
  --provider any \
  --cooldown 60 \
  --name "危险地带箱子低价"
```

Windows PowerShell 可以写成同一行。

支持指标：

| 指标 | 含义 |
| --- | --- |
| `sell_price` | 可见最低在售价 |
| `sell_count` | 可见在售数量 |
| `bidding_price` | 可见最高求购价 |
| `bidding_count` | 可见求购数量 |

支持操作符：`lt`、`lte`、`gt`、`gte`。来源可以是 `any`、`steamdt` 或 `csqaq`。

规则管理：

```bash
npm run dev -- alert rule list
npm run dev -- alert rule list --enabled
npm run dev -- alert rule disable 1
npm run dev -- alert rule enable 1
npm run dev -- alert run --once
npm run dev -- alert run
```

持续 Worker 默认每 30 分钟执行一次，可在 `.env` 修改：

```dotenv
ALERT_DEFAULT_INTERVAL_MINUTES=30
```

## 触发与安全语义

- 规则采用边沿触发：从“不满足”变为“满足”时通知一次；持续满足时不重复发送。
- 条件恢复后，下一次越过阈值才可能再次通知。
- 冷却时间用于抑制恢复后快速反复波动；冷却中的新触发会记录但不发送。
- 零价格、零数量等提供方占位值不会触发告警。
- `provider=any` 会按规则方向选择最强的可用证据，并在通知中写明实际来源和数据时间。
- 报价和数量都是公开行情快照，不代表一定可以成交，也不构成投资建议。

## 用户自定义组合规则

组合规则使用确定性的 JSON 表达式树，Agent 只负责把自然语言转换成结构化草案。标准流程是：

1. `preview_composite_alert_rule` 或 `alert combo preview` 只校验和标准化，不保存；
2. Agent 展示完整条件、窗口、冷却、连续命中次数、恢复通知和最大数据时间差；
3. 用户确认后才调用 `add_composite_alert_rule` 或 `alert combo add`；
4. `alert run` 与旧单条件规则一起评估。

示例文件位于 `examples/composite-alert-rule.example.json`：

```bash
npm run dev -- alert combo preview --file examples/composite-alert-rule.example.json
npm run dev -- alert combo add --file examples/composite-alert-rule.example.json
npm run dev -- alert combo list
```

表达式节点：

- `type=all`：全部子条件成立；任一不成立则不成立，无法判定且没有反例时为未知；
- `type=any`：任一子条件成立；全部不成立才不成立，无法判定且没有正例时为未知；
- `type=market`：行情条件；
- `type=inventory`：本地公开库存条件。

市场指标包括 `sell_price`、`sell_count`、`bidding_price`、`bidding_count`、`spread_amount`、`spread_rate` 和 `bidding_sell_count_ratio`。`mode=current` 使用当前值；`mode=change_rate` 使用本地追加观察记录计算变化率，并要求在目标时间点前后 60 分钟内存在同一提供方基线。变化率使用小数，例如下降 20% 写作 `threshold=-0.2`。

库存指标包括新增/移除数量、BUFF 基础库存估值、库存构成金额/比例变化、价格覆盖率以及高价值新增/移除事件数。库存条件只使用最近成功完整公开快照；私密、失败、不完整、缺少估值或基线时为未知。

默认行为：

- 时间窗口允许 30 分钟至 7 天；历史不足时显示等待基线，不触发；
- 必要条件未知时整条规则保持未知，不改变上次真假状态；
- 条件证据时间差超过 30 分钟时，即使逻辑满足也降级为未知；
- 默认一次命中即可触发，可设置连续 2–10 次命中；
- 默认边沿触发、冷却 60 分钟、恢复通知关闭；
- 恢复通知只有显式开启后才发送。

## 库存变动通知

公开库存监控沿用阶段 3 的安全机制：首次成功快照只建立基线；只有相邻两次成功完整公开响应产生真实差异时才通知。私密、限流、网络失败和不完整响应不会制造“全部移除”告警。

库存通知按监控任务的观察变化触发，并继承最多三次企业微信重试。组合规则还能使用已保存的库存估值、高价值事件和指定时间窗口内的新增/移除数量；它不会把移除解释为卖出。

## MCP 工具

- `add_market_alert`
- `list_alert_rules`
- `set_alert_rule_enabled`
- `preview_composite_alert_rule`
- `add_composite_alert_rule`
- `list_composite_alert_rules`
- `set_composite_alert_rule_enabled`
- `run_alert_rules_once`
- `test_enterprise_wechat`

手动测试工具会发送真实外部消息，Agent 在调用前应取得用户明确授权。
