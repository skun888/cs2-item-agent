# 库存估值与高价值异动

本模块只对完整、成功的公开 Steam 库存快照估值。私密、好友可见、限流、网络失败或分页不完整时不生成估值和高价值事件。

## 默认估值口径

- 平台：BUFF；
- 价格：精确 `marketHashName` 对应的最低在售价；
- 范围：枪皮、箱子、贴纸等所有具有精确名称且可在市场交易的库存物品；
- 数据源：同时配置时优先 SteamDT，只配置 CSQAQ 时使用 CSQAQ；一次估值不会在来源之间静默回退；
- 缓存：价格默认本地缓存 30 分钟；SteamDT 批量价格遵守每分钟一次的限制；
- 未知：缺价不按 0 元计算。

`价格覆盖率 = 已取得价格的物品数量 / 可估值物品数量`。同时保存按唯一类目计算的类目覆盖率。已知小计不等于完整库存总价。

特殊模板、极限磨损、贴纸组合、名称标签和其他单件溢价不会自动计入。当前估值只能称为“BUFF 基础类目估值”。

## 变化拆分

相邻两次成功估值分别计算：

- 库存构成变化：按本轮价格衡量数量增减造成的价值变化；
- 市场价格变化：按上轮数量衡量价格变化造成的影响。

因此，纯市场涨跌不会被描述为库存转入、转出、买入或卖出。即使观察到物品新增或消失，也只能称为公开快照差异。

## 默认高价值规则

- 单件 BUFF 基础价不低于 ¥1,000：保存高价值物品变动事件，但不单独触发高价值通知；
- 总高价值库存异动：库存构成估值变化绝对值不低于 ¥10,000，并且相对上轮已知小计变化不低于 20%；
- 覆盖率闸门：前后两轮价格覆盖率均不低于 90%；否则只保存已知小计，不判断总高价值异动。

企业微信消息优先使用本地监控标签；没有标签时只显示掩码 SteamID。消息始终带观察时间、覆盖率和限制说明。

这些默认值可在本地 `.env` 通过 `INVENTORY_PRICE_CACHE_MINUTES`、`INVENTORY_HIGH_VALUE_ITEM_CNY`、`INVENTORY_LARGE_CHANGE_CNY`、`INVENTORY_LARGE_CHANGE_RATE` 和 `INVENTORY_MINIMUM_PRICE_COVERAGE` 修改；每次运行实际采用的值可从 MCP `health_check` 查看。

## 使用

```bash
npm run dev -- inventory check 7656119XXXXXXXXXX
npm run dev -- inventory valuation 7656119XXXXXXXXXX
npm run dev -- inventory watch run --once
```

对应 MCP 工具：

- `check_public_inventory`：获取新快照并在已配置市场 API 时估值；
- `query_latest_inventory_valuation`：只读取本地最近估值，不发起新请求。
