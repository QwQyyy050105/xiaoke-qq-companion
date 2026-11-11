# 小柯：从一条官方 QQ 事件读代码

小柯通过平台应用接收事件。了解它为什么回复或沉默，先看事件如何进入授权会话，再看模型。无需登录个人 QQ 来读或测试这条链路。

| 想看或改什么 | 从这里读 | 对照的离线用例 |
| --- | --- | --- |
| 配置、面板和真实运行怎样分开 | [命令入口](../src/cli.mjs) → [公开配置](../src/public_config.mjs)；[运行入口](../src/main.mjs)负责把模块接起来 | [模板测试](../test/public_template.test.mjs)：验证面板保存、角色卡覆盖和无密钥演示 |
| 平台发来事件，为什么没有生成回复 | [QQ 客户端](../src/qq.mjs) → [群消息路由](../src/routing.mjs) → [收件队列](../src/inbox.mjs)；会话许可和撤销见[运行范围](../src/runtime_scope.mjs) | [路由用例](../test/routing.test.mjs)、[队列用例](../test/inbox.test.mjs) |
| 想换模型、改输入或处理回复 | [模型调用](../src/model_client.mjs)、[模型提供者](../src/model_providers.mjs)、[扩展加载](../src/extensions.mjs) | [模板测试](../test/public_template.test.mjs)覆盖结构化回复、取消、超时和自定义提供者 |
| 想做自己的能力插件 | [问候示例](../examples/plugins/greeting.mjs)、[模拟搜索](../examples/plugins/mock_search.mjs)及[扩展契约](EXTENDING.md) | 从仓库根目录执行 `node examples/call_capability.mjs`，对比已注册的模拟搜索与未注册的 ASR 的结果 |

改昵称或语气先用面板，改收信范围用授权配置。群昵称、人格卡和提示词都不能代替平台的 OpenID。想验证「答了但没送到」时，应核对 QQ 的实际回执；模型返回有效 JSON 只验证了生成这一步。
