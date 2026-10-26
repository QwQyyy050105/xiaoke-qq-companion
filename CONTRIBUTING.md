# Contributing

先读 README、docs/CHOOSING_A_TEMPLATE.md 和 docs/PORTABILITY.md。问题报告使用虚构消息、假 ID 和脱敏诊断。

## 本地验证

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
