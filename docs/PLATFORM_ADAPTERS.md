# 可插拔平台适配器

CS2 Item Agent 将跨平台行情接入拆成独立适配器。上层行情比较、库存 BUFF 基础估值、告警、CLI 和 MCP 只依赖统一协议，不依赖 BUFF、悠悠有品、C5 或聚合服务的私有响应字段。

## 当前边界

- 内置 `steamdt` 与 `csqaq` 两个聚合数据适配器；
- 尚未拿到合法文档和脱敏响应的 BUFF、悠悠有品、C5 接口不实现、不猜字段；
- 第一版采用源码级可信适配器：官方模块进入 `src/adapters` 并在工厂注册；不从网络下载代码，也不根据 `.env` 路径执行任意第三方脚本；
- Key、Token、Cookie 只由具体适配器从本地配置接收，描述信息和健康检查不得包含秘密；
- 适配器只提供数据，不下单、不挂单、不接受交易。

## 统一协议

每个行情适配器必须提供：

1. 稳定的小写 `id`，作为数据库和告警中的来源身份；
2. `market_quotes` 能力及 `getQuotes()`；
3. 标准化 CNY 报价，保留精确 `marketHashName`、平台、来源、观察时间和可用的在售/求购价格与数量；
4. 若声明 `batch_market_quotes`，必须同时实现 `getBatchQuotes()` 并声明单批上限和最小请求间隔；
5. 明确覆盖平台，或使用 `provider_defined` 表示上游动态覆盖。

其他能力只做声明，不强行统一返回结构。例如 SteamDT 有 K 线和检视图，CSQAQ 有监控覆盖排行、存世趋势和挂刀候选。这些能力仍由专用服务调用，避免为了“统一”而伪造空字段。

核心类型位于：

- `src/adapters/market/contract.ts`
- `src/adapters/market/registry.ts`
- `src/adapters/market/factory.ts`

## 运行规则

- 注册表按 `priority` 从小到大排序，并发查询所有已配置行情源；
- 单个适配器失败只产生该源的 `failed` 状态，其他结果正常返回；
- 未配置适配器保留能力元数据并显示 `not_configured`；
- 返回报价的 `provider` 必须等于适配器 `id`，否则按契约错误拒绝；
- 库存估值只选一个具备 BUFF 批量报价能力的适配器，默认选择最高优先级来源，不在一次估值中混价；
- 新适配器 ID 可以直接用于行情告警的 `provider`，`any` 表示任一已配置来源。

## 新增授权平台

拿到合法 API 文档和至少一份脱敏成功/失败响应后：

1. 在独立目录实现客户端，只在边界层解析并校验真实字段；
2. 实现 `MarketDataAdapter`，将响应转换为 `NormalizedMarketQuote`；
3. 为描述符声明能力、平台、优先级和真实限流；
4. 在 `createBuiltInMarketAdapterRegistry()` 注册，未配置时只注册描述符；
5. 添加成功、鉴权失败、限流、字段漂移、单源失败降级及不泄密测试；
6. 更新 `.env.example` 和平台条款说明，但不得提交真实 Key、Cookie 或响应。

可复制的无字段假设模板见 `examples/adapters/custom-market-adapter.example.ts`。模板通过注入已校验的报价读取函数工作，具体平台解析必须在取得真实文档后补充。

## 健康检查

```powershell
npm run dev -- provider list
npm run dev -- health
```

MCP 客户端调用 `health_check` 可获得相同的 `marketAdapters` 列表。该列表只说明本机配置和能力，不会请求远程接口，也不证明 Token 当前仍有权限；真实权限必须通过对应平台的安全审计或一次只读查询验证。
