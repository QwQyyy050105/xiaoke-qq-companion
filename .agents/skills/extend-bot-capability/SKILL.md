---
name: extend-bot-capability
description: Add a model, transport, app-version or media provider through this repository's actual extension contract, with honest capabilities and local integration tests.
---

# Extend a bot capability

先读 README 能力表、docs/PORTABILITY.md，以及本仓库扩展文档：docs/EXTENDING.md。核对目标系统、准确应用/网关版本、官方协议和所需能力。

复用当前 apiVersion 的插件/provider/transport 接口。只加载本机 owner 配置的模块；缺功能返回明确 unsupported，不用提示词假装接通。不要复制别人的私有 SDK、开发机路径、凭据发现逻辑或未知版本偏移。

在拥有输入的边界验证配置、版本、认证与消息形状；内部已验证数据避免重复无效检查。当前授权或配置会变的异步发送边界仍需核对最新状态，不能把旧授权当成永久事实。

实现最小可用路径，按需要处理超时、取消、错误归一化、重复事件和资源释放。模型路由不静默降级；媒体字节、身份和会话来源分开核验。重型可选模块延迟加载，缺环境不拖住设置入口。

用真实实现连接本地假 HTTP/WebSocket 服务或合成平台事件，验证插件确实被调用、正确会话发送、取消后的迟到结果不外发。无需为普通扩展调用真实群聊或付费模型。

更新能力表、配置示例、生成 schema 的源、迁移和实际支持版本。注明配置立即生效还是重启；只实现接口的部分明确标成预留。不要为了遥远假设增加大规模抽象。
