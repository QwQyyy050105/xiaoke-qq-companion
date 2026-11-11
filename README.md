# Xiaoke QQ Companion · 小柯

面向 **QQ 官方机器人应用** 的可扩展聊天模板：上下文、独立人格卡、多人消息排队、发送回执、本机面板和可替换模型。它使用 AppID/AppSecret 和腾讯事件权限，不代理个人 QQ 号，也不要求桌面 QQ 常开。

三个模板各自部署：小柯用 QQ 官方应用；小汐连接 Windows 微信；大肥鱼连接 OneBot v11 网关。三者的账号和授权不能互换。详见[路线选择](docs/CHOOSING_A_TEMPLATE.md)与[可移植性说明](docs/PORTABILITY.md)。

要改代码，先看[QQ 事件、队列和模型的代码入口](docs/CODE_MAP.md)，其中列有各环节对应的离线用例。

## 从离线演示开始

安装 Node.js **22 或更新版本**，终端进入本仓库：

```sh
npm ci
npm run init
npm run demo
```

只需要文字聊天、API 模型和本地面板时，可以把安装命令换为 `npm ci --omit=optional`。精简模式省略公式排版、浏览器自动化、SILK 语音编码依赖；具体能力差异与恢复方法见 [安装体积选择](docs/PORTABILITY.md#选择安装体积)。完整开发测试使用标准安装。

打开终端打印的本机地址（默认 `http://127.0.0.1:8794`），在“本地试聊”输入一句话。看到包含输入文字的“演示回复”就跑通了离线路线。角色与配置可以在面板里保存，按 Ctrl+C 结束。无人值守检查用 `npm run demo -- --smoke`，成功会打印 `DEMO_SMOKE_OK` 并退出。

| 下一步想做什么 | 从这里开始 |
| --- | --- |
| 用自己的官方 QQ 机器人收发 | [接入真实 QQ](#接入真实-qq) |
| 带着人设换电脑，或恢复原机器人的记忆 | [迁移小柯到另一台电脑](docs/PORTABILITY.md#迁移小柯到另一台电脑) |
| 面板能开，QQ 却没有回复 | [顺着一条测试消息排查](docs/PORTABILITY.md#顺着一条测试消息排查) |

## 接入真实 QQ

1. 在腾讯 QQ 开放平台创建机器人应用，确认群聊/单聊事件、测试范围和审核权限。普通个人 QQ 账号不能直接代替。
2. 在仓库目录执行 `npm run init`，打开生成的 `.env`，填写 `QQ_APP_ID`、`QQ_APP_SECRET` 和自行生成的强 `QQ_PAIRING_CODE`。已有的 `.env` 会保留。密钥只保存在自己的设备上。
3. 运行 `npm run init`，将配对口令转换为哈希保存。通过 `npm run panel` 配置模型；推荐先选 OpenAI-compatible，填写服务商 baseURL、模型名和密钥环境变量名。API 模型必须支持结构化 JSON 输出；远程 HTTPS 密钥放 `.env` 的 `MODEL_API_KEY`；本机 `http://localhost` / `127.0.0.1` / `[::1]` 服务可不设密钥，程序不会发送 Authorization。高级设置可选择 `max_tokens` / `max_completion_tokens`，以及服务商不支持 response_format 时的“仅提示词约束”；两种方式都会验证返回 JSON。
4. 填写允许访问的官方群 OpenID/用户 OpenID。它们来自官方测试事件/开发者后台，不是 QQ 群号、昵称或普通 QQ 号码。**默认名单为空，机器人不会处理任何真实会话。**
5. 在配置面板所在的终端按 Ctrl+C，运行 `npm run doctor` 检查配置，再 `npm start`。真实服务会启动自己的面板。在已授权私聊用 `/pair 你的口令` 完成主人配对，然后在已授权群 @ 机器人发一句有明确答案的问题，核对 QQ 客户端里收到的回复。

`npm run doctor -- --json` 在本机核对配置和凭据是否已填写，输出中不显示密钥值。尚有待配置项时会报告 `needs_setup` 并正常退出。`npm run chat` 可在终端测试当前模型。Windows PowerShell 若提示无法执行 npm.ps1，可以在这些命令里用 `npm.cmd` 调用 npm。

## 已实现与扩展边界

| 功能 | 状态/条件 |
|---|---|
| 官方 QQ 收发、多人上下文/队列、取消、真实回执 | 已实现；依赖账号事件权限/额度 |
| 人格预设、别名/语气、模型、会话白名单、静默时间面板 | 已实现；配置验证并原子保存 |
| Mock、OpenAI-compatible Chat Completions、Codex CLI | 已实现；Mock 离线；后两者需自行配置服务 |
| PNG/JPEG 图像输入 | 核心已实现；允许 vision 且模型支持看图；不附带私人素材 |
| 图片/语音库与群内收藏 | 核心已实现；公开模板素材库为空 |
| 数学排版、GIF/WebP 采样、独立浏览、原生作图 | 可选运行环境；默认关闭，先配置再验收 |
| 接收语音并回复（ASR） | 可直接用 QQ 自带转写。只有未听清的语音时，私聊和群内 @ 会收到请改发文字的提示；附带问题仍能回答。Windows 可在面板勾选“入站语音转写”，缺转写时使用本机已安装的桌面语音识别器；其他系统可接 ASR 插件。见[接收语音](docs/EXTENDING.md#接收语音)。 |
| TTS／搜索外部提供者 | 提供 v1 调用接口；自动使用取决于具体执行器及配置。 |
| 插件前后钩子、替换生成器 | 已接入真实生成路径，附可运行例子与离线测试 |
| 跨群/私聊资料共享 | 默认隔离；只提供当前会话的观察/记忆 |

主动参与默认关闭；`mentioned` 仅处理叫名/@，`contextual` 启用上下文接话，`active` 还允许定时参与，仍须面板“主动发起话题”开关和 QQ 平台权限。静默起止小时相同代表全天可接话，其他区间按所选时区跨午夜计算。关闭视图不等于结束服务，电脑/服务器进程必须在线。

## 维护与二次开发

```sh
npm test
npm run demo -- --smoke
npm run doctor -- --json
npm run check:release
```

参考 [实际验收记录](docs/VALIDATION.md)、[插件、API 与适配器](docs/EXTENDING.md)、[新手提问模板](docs/BEGINNER_PROMPTS.md)、[贡献说明](CONTRIBUTING.md)。配置 `schemaVersion=1`，插件 `apiVersion=1`。核心和面板在 Windows/Linux/macOS 的 Node 22+ 上运行；可选桌面/媒体执行器另列要求，不把作者电脑的 D 盘路径当作用户要求。

仓库不包含账号、聊天记录、个人形象/声音或部署缓存。面板人格修改写入 `character_card.local.json`，分发默认卡保持不变。配置、数据与日志留在自己的克隆目录并由 `.gitignore` 排除。日志不代表模型订阅费用/余额。多人服务应进一步接入自己的审计、备份和保留策略。

MIT；改编思路来自 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)。详见 [第三方声明](THIRD_PARTY_NOTICES.txt)。

## AI maintenance workflows

Read [AGENTS.md](AGENTS.md) for project boundaries and task routing. Reusable project skills cover release verification, adapter/provider extensions, personality edits and incident handoff under `.agents/skills/`. These files do not install a global agent or an operating-system sandbox.

Windows 可在安装依赖后双击 `Start_Panel.cmd` 打开本机配置面板；它不会自动登录平台或发送消息。终端窗口保持运行，Ctrl+C 停止服务。`Start_Panel.cmd --check` 只检查启动条件。

发布隐私、默认权限、真实模型数据流与高级路线边界见 [安全与模型扩展说明](docs/SECURITY_AND_MODELS.md)。
