# 数据能力、市场分析与挂刀评估

阶段 5 将 SteamDT 历史 K 线与 CSQAQ 个人接口组合为可复核的决策数据层。它提供筛选和情景压力测试，不自动交易，也不承诺七日后的价格。

## 可用命令

```bash
npm run dev -- csqaq holders "M4A4 | Hellfire (Factory New)" --limit 10
npm run dev -- csqaq supply "M4A4 | Hellfire (Factory New)"
npm run dev -- csqaq cases --limit 20
npm run dev -- fees show
npm run dev -- market trade "M4A1-S | Nightmare (Factory New)" --platform STEAM --type 1 --context-file examples/market-trading-context.example.json
npm run dev -- sector list
npm run dev -- sector kline thousand_weapon --interval 1day
npm run dev -- collection sync --search 核子危机 --limit 3
npm run dev -- collection analyze 核子花园
npm run dev -- hanging screen --target steam --source BUFF --steam-exit highest_bid --min-price 1 --max-price 500 --turnover 10 --limit 20
npm run dev -- hanging screen --target platform --source BUFF --steam-buy listing --platform-exit highest_bid --min-price 1 --max-price 500 --turnover 10 --limit 20
npm run dev -- hanging assess "AUG | Ricochet (Field-Tested)" --target platform --source BUFF --steam-buy listing --platform-exit highest_bid --platform STEAM --type 1 --min-price 1 --max-price 500 --turnover 10
```

## 两套独立模型

核心明确区分：

- `market_trading`：分析单品趋势、同级板块、有效流通盘估计、CSQAQ 监控样本集中度、大商运作专家标注和汰换上下游；不回答七日保护后是否容易退出。
- `hanging_execution`：分析买入价、Steam 退出价、实际费率、活跃度、品类准入和七日三情景；不回答大商是否运作或中长期行情价值。

两套模型可以共享当前价格和 K 线，但不共享最终分数。用户同时问行情和挂刀时，应分别返回两个结论；“行情属性较强，但不适合挂刀”是合法结果。

`market trade` 是新的明确命令，`market decide` 保留为兼容别名。可通过 `--context-file` 提供本地 JSON 专家上下文。板块截图、有效流通盘估计和“大商推动”等内容会进入 `expertAnnotations`，不会混入 `verifiedObservations`。示例见 [market-trading-context.example.json](../examples/market-trading-context.example.json)。

CSQAQ 板块数据现在可以直接进入行情模型：`sector list` 保存当前指数与每日卡价，`sector kline` 保存历史 OHLC 并计算 1/7/15/30 日表现。板块 K 线是提供方定义的指数观察，不是成交记录；当前真实响应中的 `volume` 为 0，不能据此声称板块有真实成交量。

`collection sync` 将指定的收藏品、饰品、稀有度和参考价分批保存到本地 SQLite，`collection analyze` 返回同级与相邻上级。从消费级逐级汰换到隐秘（红皮）均按十件合同建模；隐秘（红皮）到刀具/手套等稀有特殊物品按五件合同建模。自 Valve 2026-05-20 更新后纪念品可以参与合同，但纪念属性会被移除并产出普通品质；在纪念包尚未映射到基础收藏品时，程序返回 `base_collection_required`，不会用纪念品价格伪造输出篮子。收藏品详情同步失败会保留失败项，不会静默生成关系。

挂刀自动候选池默认优先武器箱并允许普通枪皮；贴纸、布章、刀、手套和无法识别品类默认排除。用户明确指定这些品类时仍返回数值评估，但保留品类警告，且不会自动升级为 `candidate`。使用 `--include-excluded` 仅用于审计被过滤候选。

### 有效流通盘与板块

- 名义存量继续保留为提供方观察；有效流通盘必须携带来源、日期，建议使用低值/中心值/高值区间。
- 单品与板块采用最接近的可用收益窗口比较，并明确窗口误差，例如单品 14 日对板块 15 日。
- CSQAQ 样本 Top 10 数量可除以有效流通盘中心估计，但该结果仍不是全网集中度。

### 汰换上下游

行情模型允许记录饰品是汰换输入、输出或两者兼有，并记录合约投入件数和上下级名称。只有完整提供材料单价、所有结果概率和结果参考价，且概率和等于 1 时，核心才计算静态期望值；缺字段时只保存关系，不编造结果。

静态正期望只表示可能形成材料消耗需求，不能证明合约正在大量执行，也不能证明材料必涨。磨损组合、手续费、成交深度和价格冲击仍属于限制。

`holders` 会先通过名称解析 `good_id`，再读取 CSQAQ 监控范围内的持有人排行。同一 SteamID 若对应多个监控任务，只保留最大持有量，避免重复计数。报告同时返回原始行数、去重账号数、Top 1/5/10 持有量和样本内占比。

这些占比的统计总体是“CSQAQ 已监控且当前可观测账号”，不是 Steam 全网，也不能证明账号背后的实际受益所有人。

`supply` 返回提供方近 180 天存世量记录和 7/30/90 日及全窗口变化。存世量是提供方统计口径，不能被解释为项目自行枚举了所有单件指纹。

`cases` 通过 `good_id` 连接开箱数量与回报率。缺少 `good_id` 的回报率行无法安全连接，会被排除。回报率是提供方计算的期望值，不代表一次开箱结果。

## 本地缓存

SQLite 迁移 6 新增：

- `provider_cache`：缓存数据、来源、观察时间、过期时间和限制说明；
- `decision_reports`：追加保存挂刀初筛与单品评估报告。

默认缓存周期：目录映射 30 天、持有人排行 10 分钟、存世量 25 分钟、挂刀候选 15 分钟、武器箱统计 20 分钟。缓存只保存在用户本机，不进入 Git。

CSQAQ 客户端普通数据请求默认至少间隔 1.1 秒。缓存过期后才重新请求，减少免费额度消耗和限流风险。

## 费率与筛选模板

内置模板仅用于开箱即用的示例计算。复制 [fee-template.example.json](../examples/fee-template.example.json) 到被 Git 忽略的本地目录，再设置：

```dotenv
FEE_TEMPLATE_PATH=./local/fee-template.json
```

模板包括：

- `steamSaleNetRate`：Steam 售出后的示例到账系数；
- BUFF/YYYP 买入费率和固定成本；
- `riskBufferRate`：滑点、误差或个人成本缓冲；
- `steamMarketReferenceCnyPerUsd`：把 Steam 人民币展示价换算为美元面值时采用的本地参考汇率；
- BUFF/YYYP 国内平台出售费率；
- Steam 余额比例、平台现金收益率、异常求购/在售价和活跃度的独立筛选阈值。

每份挂刀报告会完整回显实际模板、来源和阈值。平台规则变化时必须修改本地模板，不能把内置值当成永久费率。Agent 在调用前必须先询问目标是“获得 Steam 余额”还是“获得平台余额”，不得把两个方向合并排序。

### 获得 Steam 余额

资金路径为“国内平台人民币买入 → Steam 挂底价或丢求购出售 → Steam 余额”。核心指标是每 1 元人民币成本可获得的 Steam 到账余额；这不是现金利润率，也不使用每日美金卡价。

### 获得平台余额

资金路径为“按每日美金卡价取得 Steam 美元余额 → Steam 挂底价或求购买入 → 七日后在 BUFF/悠悠挂底价或丢求购出售 → 平台人民币余额”。报告回显 CSQAQ 当日 `CNY/100 USD` 卡价、Steam 人民币/美元参考汇率、国内平台出售费率、人民币资金成本、平台净回款和现金口径情景收益率。卡价缺失时保持未知，不退回另一套公式。

## 七日情景方法

单品评估使用 SteamDT K 线：

1. 取每个 UTC 日的最后收盘价；
2. 基础情景为近 7 日动量的 40%，限制在 ±12%；
3. 防守/乐观情景为基础情景加减 `1.28 × 近 30 日波动率 × √7`，最终限制在 ±50%；
4. 将三个价格变化情景应用到当前 Steam 退出价；
5. 按本次费率模板计算 Steam 到账余额与实际人民币买入成本的比例。

该模型是可解释的压力测试，不是经过充分回测的预测模型。`steamBalancePerCny` 表示每 1 元人民币买入成本预计对应多少 Steam 余额；Steam 余额和可提现现金不是同一种资产，因此它不是现金利润率。

当前 `candidate / caution / avoid` 只表示是否通过本地模板阈值。阈值仍需结合项目负责人的挂刀经验继续校准；在阶段 6 的 Agent 解释中也必须展示这些假设，不得只输出一个标签。

## 数据来源边界

- CSQAQ 名称到 ID：[获取饰品的 ID 信息](https://docs.csqaq.com/api-187131777)
- CSQAQ 持有人排行：[库存监控持有量排行榜](https://docs.csqaq.com/api-187131813)
- CSQAQ 存世量：[近 180 天走势](https://docs.csqaq.com/api-366480669)
- CSQAQ 挂刀候选：[挂刀行情详情](https://docs.csqaq.com/api-187131823)
- CSQAQ 板块与每日卡价：[首页相关数据](https://docs.csqaq.com/api-187131779)
- CSQAQ 板块 K 线：[指数 K 线图](https://docs.csqaq.com/api-278085071)
- CSQAQ 收藏品目录：[所有收藏品](https://docs.csqaq.com/api-187131826) 与 [单个收藏品包含物](https://docs.csqaq.com/api-187131825)
- CSQAQ 武器箱：[开箱数量](https://docs.csqaq.com/api-187131788) 与 [回报率](https://docs.csqaq.com/api-294405260)

上述权限、刷新频率和数据结构可能变化。适配器遇到不兼容字段应明确失败或进行有记录的兼容处理，不能静默编造。
