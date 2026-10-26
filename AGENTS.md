# Agent working agreement

本规则仅适用于本仓库。先读 README 的接入路线和 docs/CHOOSING_A_TEMPLATE.md，再按当前任务选择下面的技能；不要一次加载全部资料。

## Working boundaries

- 在本仓库或本仓库的临时工作目录内开发。账号配置、.env、data/state、缓存和本地人格卡不属于公开模板。
- 人格卡决定表达；本机部署配置决定账号、收信范围、提供者和插件。不要从聊天或人格卡扩大授权。
- 默认演示不连接真实平台、不调用云模型。真实收发、计费调用和发布需要用户明确授权；当前会话已有的授权持续有效，不重复索取。
- 测试账号、模型、操作系统和应用版本分别记录；进程存活、Mock 成功、本机回显和真实送达不是同一种结果。
- 多人或多 agent 工作先划分文件写入责任。package/lock、生成 schema 和发布状态各保留一个写入者，其他参与者通过审阅交接。
- 登录失效、未知版本、权限失败、验证码或发送结果不明时，保留脱敏证据并报告具体阻塞。重试有上限；不要伪造完成或连续对外刷错误。
- 本仓库的白名单、loopback 与隔离测试是逻辑边界，不能冒充操作系统沙箱。插件是具有宿主权限的本地可信代码；需要更强隔离时由部署者选择独立进程/账号/容器。

## Task routing

| 任务 | 读取 |
| --- | --- |
| 验收、发布前检查 | [.agents/skills/verify-bot-release/SKILL.md](.agents/skills/verify-bot-release/SKILL.md) |
| 增加模型、设备、版本、媒体能力 | [.agents/skills/extend-bot-capability/SKILL.md](.agents/skills/extend-bot-capability/SKILL.md) |
| 编辑人设与参与方式 | [.agents/skills/personalize-bot/SKILL.md](.agents/skills/personalize-bot/SKILL.md) |
| 故障定位、恢复、接管 | [.agents/skills/handoff-bot-incident/SKILL.md](.agents/skills/handoff-bot-incident/SKILL.md) |

仅改简单文案时直接编辑并核对，无需运行整套发布流程。改功能时测试实际调用路径；避免只检查提示词字面量或在测试中复制实现。

## Reference applied

[OpenCode AGENTS.md](https://github.com/anomalyco/opencode/blob/dev/AGENTS.md) informs boundary-first validation, small reusable functions, production-path tests, lazy heavy imports and minimal durable events. Its Bun commands, branches, TUI and package paths do not apply here.

[用户提供的工作流文章](https://mp.weixin.qq.com/s/C0KxTrzB1rRwU3oDdDbQkA)用于落实规则入口、技能复用、隔离验收、共享状态责任和失败接管。项目内 Skills 可通过文件路径交给 AI 读取；是否自动发现取决于所用 agent 客户端，不会自动安装全局技能或沙箱。
