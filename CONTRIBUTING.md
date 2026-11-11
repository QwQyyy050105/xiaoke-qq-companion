# Contributing

第一次参与，请从[本地运行](README.md)、[模板区别](docs/CHOOSING_A_TEMPLATE.md)或[换机与环境要求](docs/PORTABILITY.md)进入。实现新功能前先看[本仓库的扩展契约](docs/EXTENDING.md)；复现问题请用虚构消息、假 ID 和脱敏诊断。

## 本地验证

从[源码导读](docs/CODE_MAP.md)可以按问题找到消息入口、模型调用、发信路径和对应的离线用例。

使用 package.json 声明的 Node 版本，从新目录运行：

```sh
npm ci
npm test
npm run demo -- --smoke
npm run doctor -- --json
npm run check:release
```

无真实凭据时 doctor 可以报告待配置；离线测试不得依赖真实账号或付费模型。平台与模型的真实验收单独记录。

更改 provider/transport 时加本地假 HTTP/WebSocket 服务测试，覆盖超时、取消、错误、重复消息和权限。面板验收保存后重读、密钥脱敏和无效配置。简单文案无需镜像实现的测试。

只提交源码、示例、必要文档和许可证，不提交依赖安装、状态、账号文件、缓存、历史或个人媒体。check:release 检查候选源文件；首次发布还需人工审阅暂存区和完整 Git 历史。

保留上游许可证与来源。新增依赖检查锁文件和许可，不复制不可再分发的 SDK、客户端、模型权重或个人素材。

新功能优先走版本化扩展接口，注明配置迁移、兼容范围、已实现与预留部分。插件是本机可信代码。人格卡和聊天不能改变部署权限。

PR 说明具体问题、最终行为、验证命令和未验组合。模拟检查不能称为真实账号收发。

## Actions 里的红叉怎么排查

通知绑定的是某一次运行。先到**自己的 fork** 打开 Actions → Offline quality，核对分支和提交号。旧通知与最新提交可能指向不同结果；以所查提交的运行结果为准。

1. 打开失败的任务，记下系统、Node 主版本和**第一个失败步骤**。同一提交会分别在 Windows 和 Ubuntu 的 Node 22 / 24 上运行。
2. 对照[工作流文件](.github/workflows/ci.yml)在干净目录执行那一步。安装和依赖审计需要访问包源；只有这两步失败时，先区分网络错误和审计列出的具体依赖。若演示失败，先复现 `npm run demo -- --smoke`，无需填写账号或密钥。
3. 在修复后的提交上确认对应任务通过。提 [Bug 报告](.github/ISSUE_TEMPLATE/bug_report.yml) 时附提交号、失败步骤、退出码和脱敏后的错误行即可；新增平台或模型走[扩展提案](.github/ISSUE_TEMPLATE/extension_request.yml)。
