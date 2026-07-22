# Steam 与 SteamDT 检视图真实能力审计

审计时间：2026-07-21（Asia/Shanghai）

本审计使用项目负责人本地 `.env` 中的 SteamDT Key、已授权监控的公开 Steam 库存，以及一条自定义 masked DIY code。报告与命令输出均不保存或展示 API Key、SteamID、assetid、物品证书或完整检视链接。

## Steam 当前实际提供的数据

Steam 公开库存响应已确认包含：

- 资产、描述、公开市场名称及交易/市场状态；
- `asset_properties` 中的图案模板、精确磨损、挂件模板、名称标签、物品证书和皮肤编号（字段是否存在取决于物品）；
- `asset_accessories` 中的贴纸/挂件关联属性；
- `actions.link` 中的检视入口模板。

新版响应的检视入口通常不是旧式 `S/M/A/D` 链接，而是：

```text
steam://.../+csgo_econ_action_preview%20%propid:6%
```

其中 `%propid:6%` 必须使用同一资产 `asset_properties` 的“物品证书”替换。项目此前只处理 `%owner_steamid%` 和 `%assetid%`，导致真实检视入口丢失；当前适配器已修复该兼容问题。

Steam 数据可以生成或恢复真实物品的新版检视代码，但 Steam 公开库存接口本身不提供渲染截图。

## SteamDT 调用结果

| 输入与接口 | HTTP/外层状态 | 内层结果 | 可用数据或图片 |
|---|---:|---|---|
| Steam 真实证书 → `/v1/wear` | 200 / success | `sync=true, success=true` | 可取得 defindex、paintindex、磨损、模板和贴纸；成功验证 1 张已贴贴纸 |
| Steam 真实证书 → `/v1/inspect` | 200 / success | `sync=true, success=false` | 无 front/back/detail 图片 |
| 自定义 DIY code → `/v1/wear` | 200 / error 4006 | 失败 | 无数据 |
| 自定义 DIY code → `/v1/inspect` | 200 / error 4006 | 失败 | 无图片 |
| Steam 真实证书作为 v2 `d`，`s/m/a=0` | 200 / success | wear 持续 pending；inspect 失败 | 5 秒后重复查询仍无数据和图片 |
| 自定义 DIY 证书作为 v2 `d`，`s/m/a=0` | 200 / success | wear 持续 pending；inspect 失败 | 5 秒后重复查询仍无数据和图片 |

另一次无贴纸真实物品测试中，`/v1/inspect` 曾返回 `sync=true, success=true` 和 screenshot 对象，但 front/back/detail URL 仍全部为空。因此不能把 HTTP 200、外层 `success=true` 或 screenshot 对象存在等同于已经生成图片。

## 同步、异步与 notifyUrl

- v1 真实证书的 `/wear` 本次同步完成，不需要回调。
- v2 的零 ASMA + 证书尝试返回 taskId，但等待 5 秒后再次请求仍未完成，随后的 inspect 也明确失败。
- 本地 Agent 没有公网回调地址。本次未把私有库存负载发送到第三方 request-bin，也未伪造 `notifyUrl`。
- 当前公开文档没有提供按 taskId 查询结果的独立端点。因此仅有 taskId、没有图片或成功结果时只能标记为 pending/unknown，不能宣称已渲染。

## 工程结论

1. Steam 是真实物品属性和新版物品证书的有效来源，必须保留。
2. SteamDT `/wear` 能补全或校验 Steam 真实物品参数。
3. 截至本次真实审计，SteamDT 个人开放 API 不能为本项目的自定义 DIY code 稳定输出渲染图。
4. `render_diy_preview` 只有拿到至少一个非空 HTTP 图片 URL 时才能返回 `steamdt_game_render`；内部失败或空截图必须降级为 `inspect_code_only`。
5. 若产品必须在 Agent 对话内直接显示真实渲染图，需要新增独立 `DiyRenderer`：获得明确授权的第三方截图 API，或读取用户本机 CS2 资源的本地渲染 Worker。不能通过抓取 SteamDT 网站内部接口来绕过开放 API 边界。

## 可复现命令

```powershell
npm run audit:steamdt-inspect -- --custom-code "<masked hexadecimal inspect code>"
```

脚本会优先使用本地 Steam 公开库存快照中的物品证书，只输出脱敏结构摘要。SteamDT 官方文档：

- https://doc.steamdt.com/273806087e0
- https://doc.steamdt.com/273806089e0
- https://doc.steamdt.com/273806090e0
- https://doc.steamdt.com/6369437m0
