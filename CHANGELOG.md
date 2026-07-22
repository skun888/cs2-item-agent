# Changelog

本文件记录 CS2 Item Agent 的用户可见能力与发布边界。版本号遵循语义化版本。

## 0.8.0-alpha.1 - 2026-07-22

首个可回滚的源码预发布基线。

### Included

- 42 个本地 stdio MCP 工具，覆盖行情、双源比价、市场交易、双向挂刀、板块与汰换、公开库存、估值、告警和饰品 DIY；
- SteamDT 与 CSQAQ 可插拔市场适配器，以及单来源失败隔离和来源归属校验；
- 12 个追加式 SQLite 迁移；
- 专属 `cs2-item-agent` Skill、证据政策、工具契约和副作用边界；
- 79 项自动化测试，以及带强制断言的本地 MCP 健康检查和协议验收；
- Windows 与 Linux 的 Node.js 24 CI 发布验证。
- MCP `health_check` 自带中文首次使用说明和动态 API Key 配置引导，只返回变量名、布尔状态、能力影响与安全验证方式，不返回秘密值。
- 新增统一发布与功能升级验收标准；`npm run acceptance:check` 同时作为本地与 Windows/Linux CI 自动化发布门槛。

### Release boundaries

- 这是源码预发布基线，尚未发布 npm 包、预编译程序或 Docker 镜像；
- `node:sqlite` 在当前 Node.js 24 运行时仍可能输出实验性警告；
- 费率模板内置值仅是示例，真实挂刀使用前必须配置和回显用户本地实际参数；
- 项目不执行购买、出售、挂单、交易或隐私绕过。
