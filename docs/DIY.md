# 饰品 DIY：真实目录、检视代码与审美反馈

阶段 7 的 DIY 是本地、可解释的搭配工具，不是独立的 CS2 三维渲染器。商品身份、类型、价格和图片来自用户配置的数据源；颜色、明暗、饱和度、复杂度及风格标签由本机根据商品图计算。

Steam 与 SteamDT 的真实接口验收结果见 [Steam 与 SteamDT 检视图真实能力审计](./STEAMDT_INSPECT_AUDIT.md)。截至 2026-07-21，SteamDT 个人开放 API 可以解析 Steam 真实物品证书，但未能为自定义 DIY code 返回渲染图片。

## 正式预览链路

```text
CSQAQ 目录与商品详情
  → 本地 SQLite 目录
  → CS2 武器 defIndex / paintIndex 与贴纸 kit ID
  → 风格、预算和布局规则推荐
  → 生成 masked inspect code
  → SteamDT 公开检视接口（可用时）返回游戏渲染图
  → 否则返回可复制到 CS2 的真实检视代码
  → 用户评分与标签反馈
  → 下一次规则排序加权
```

旧版 `recipe-*.svg` 只是使用商品图片和通用画布坐标制作的排版草图，贴纸并未映射到 CS2 武器表面的真实槽位，所以不能作为“贴上后的效果图”。该路径已经弃用，运行时不再把它当作正式预览返回。

正式预览遵循以下规则：

- 始终以可解码的 CS2 检视代码作为预览事实载体；
- 只有上游确实返回游戏渲染截图时，才把图片标记为 `steamdt_game_render`；
- 上游没有返回截图时，输出 `inspect_code_only`、检视代码、解码参数和失败原因，不生成伪装成真实槽位的图片；
- 推荐方案缺少武器 `defIndex`、`paintIndex` 或贴纸 `sticker kit ID` 时明确失败，并提示先补全目录；
- 新版自由贴纸的精确偏移、缩放、旋转和磨损只有在检视参数中存在时才能还原；自动方案当前使用 CS2 默认槽位。

目录同步是搜索分页子集，不代表完整目录；目录项也不证明当前在售。远程图片只缓存在被 Git 忽略的 `data/diy-images`，真实渲染图缓存在 `data/diy-previews`；数据库、图片和反馈均不上传。

## CLI

```powershell
npm run dev -- diy catalog sync "AK-47 | Slate" --pages 1 --page-size 20
npm run dev -- diy catalog enrich "AK-47 | Slate (Factory New)" --kind skin --limit 1
npm run dev -- diy catalog sync "Sticker |" --pages 1 --page-size 50
npm run dev -- diy catalog enrich --kind sticker --limit 20
npm run dev -- diy catalog list --kind sticker --enriched --limit 20
npm run dev -- diy recommend "AK-47 | Slate (Factory New)" --style black_gold --budget 100 --slots 4
npm run dev -- diy preview 1
npm run dev -- diy inspect "csgo_econ_action_preview 00..."
npm run dev -- diy decode "csgo_econ_action_preview 00..."
npm run dev -- diy feedback 1 --rating 5 --selected --liked gold,uniform
npm run dev -- diy preferences
```

`diy preview <recipeId>` 根据本地推荐方案生成检视代码并尝试获取真实渲染图。`diy inspect <code>` 接受用户已有的 masked inspect code。`diy decode <code>` 只在本地解析武器、皮肤、磨损、模板及贴纸位置参数，不访问网络。

支持的第一版风格为 `minimal`、`monochrome`、`black_gold`、`contrast`、`cyberpunk`、`esports` 和 `anime`。每次返回统一重复、视觉焦点和混搭三类候选，再按规则得分排序。

## MCP 工具

- `sync_diy_catalog`、`enrich_diy_catalog`、`search_diy_catalog`
- `recommend_diy_loadouts`、`render_diy_preview`
- `record_diy_feedback`、`get_diy_preferences`

`render_diy_preview` 可接收 `recipeId` 或 `inspectCode`。Agent 应先确认目录中已有目标枪皮和足够的已补全贴纸。同步或补全会读取外部 API 并写入本地目录；推荐会写入本地方案；反馈必须来自用户明确评价，Agent 不得替用户虚构评分。

## 评分边界

推荐使用以下显式输入：商品图的主色、明暗、饱和度和复杂度，用户指定风格，有效平台报价和预算，布局策略，以及用户本地历史反馈。

零价格被视为缺失值。审美得分不是事实或保值判断；贴纸价格不等于贴上后的增值。检视代码能够描述 CS2 接受的物品参数，但不等于本项目拥有独立游戏渲染能力；最终光照、动画与视角仍以 CS2 客户端显示为准。

## 后续迭代

阶段 8 的专属 Skill 将在真实用户评价基础上补充风格词典、武器槽位经验、贴纸主题知识和回答规范。核心程序继续负责目录、确定性计算、检视代码和反馈；Skill 负责指导 Agent 解释与追问，不负责创造商品事实。
