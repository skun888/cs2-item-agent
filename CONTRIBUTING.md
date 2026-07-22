# 贡献指南

感谢参与 CS2 Item Agent。项目已经确认本地优先、模型无关、Skill 负责路由与解释、MCP 负责事实与确定性计算的架构；功能贡献应在该架构内演进。

## 开发准备

需要 Node.js 24 或更高版本。Fork 或 Clone 仓库后执行：

```bash
npm ci
npm run acceptance:check
```

请从最新 `main` 创建独立分支，不要提交 `.env`、API Key、Token、Webhook、Cookie、真实 SteamID、本地数据库、缓存或用户库存。

## 提交要求

- 新能力必须包含专项自动化测试，并保持 42 个现有 MCP 工具及其兼容契约不被无意破坏；
- 市场与库存结果必须保留来源、观察时间、覆盖范围和限制，失败或不可见状态不得伪装成零值；
- 新增外部请求前应提供合法文档或脱敏契约证据，不猜测私有接口字段；
- 会写入本地状态或发送外部消息的工具必须保留明确的用户意图与确认边界；
- 更新 canonical Skill 后运行 `npm run skill:sync`，不要手工维护生成的 Skill 适配入口；
- 提交 Pull Request 前运行 `npm run acceptance:check`。发布候选还应按 [`docs/RELEASE_ACCEPTANCE.md`](./docs/RELEASE_ACCEPTANCE.md) 完成实机、真实只读数据和安全验收。

## 问题报告

普通缺陷可以提交 GitHub Issue，并附上脱敏后的系统、Node.js 版本、Agent 客户端、复现步骤和错误类型。不要在 Issue、截图或日志中粘贴任何秘密或个人库存信息。敏感漏洞请改用 [`SECURITY.md`](./SECURITY.md) 中的私密报告方式。
