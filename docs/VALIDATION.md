# 本地验收边界

## 2026-11-11 换机与启动

Windows 11，Node.js 24.22.1。将公开源码导出到含中文、空格和 `#` 的干净目录，从另一个目录运行入口。测试初始化时只使用临时配置和虚构数据。

- `npm ci --offline --include=optional` 使用已缓存的锁定依赖完成安装。运行 `npm test` 时拦截从上级目录加载的 npm 依赖。基础环境 1,190 项通过，2 项因未指定 Python/Pillow 跳过。指定 Python 3.12.14、Pillow 12.3.0 后完整重跑，1,192 项通过，0 失败、0 跳过。
- 部分恢复分别覆盖仅有 `config.local.json` 和仅有 `.env` 两种情况，运行 `init` 只补缺失文件。离线 Codex 诊断能区分失效的旧路径与新 PATH 中的候选执行文件，全程未启动模型。
- 在项目目录外执行 `npm.cmd --prefix "<项目目录>" run doctor -- --json` 与 `run demo -- --smoke`。未配置账号时诊断返回 `needs_setup`，Mock 面板实际响应后打印 `DEMO_SMOKE_OK`。Windows 启动器 `Start_Panel.cmd --check` 对空 `node_modules` 返回 1，对完整安装与 `npm ci --omit=optional` 精简安装均返回 0；精简安装的 Mock 试聊同样通过。
- `npm run check:release` 通过公开源码扫描。`npm audit --omit=dev --audit-level=high` 在本次检查返回 0 个已知依赖漏洞。本轮实机范围为 Windows 离线接入与本机 HTTP；没有使用真实 QQ 或云模型。其他系统和 Node 版本以相应提交的 CI 结果为准。

随后从正常服务入口复验离线开机。执行 `node --test test/qq_startup_recovery.test.mjs test/qq_gateway.test.mjs test/core.test.mjs`，共 21 项通过。临时部署的 QQ 令牌与网关请求接入本机 HTTP/WebSocket 模拟服务。首次令牌请求返回 503，恢复后同一进程建立会话、接收私聊并提交一次配对回复。模拟端随后返回凭据错误 100016，程序以状态码 1 退出并释放实例锁。单独用例覆盖令牌请求进行中和重连等待中两种停止时机。修复后的 `node --test "test/*.test.mjs"` 回归 1,192 项全部通过，包括两个可选动画用例。

## 2026-10-26 核心与可选能力

2026-10-26，Windows，Node.js v24.22.1，KaTeX 0.18.2；可选动画解码使用标准 venv 中的 Python 3.12.2 / Pillow 13.0.0。公开源码副本测试，未访问真实 QQ、微信、聊天数据库、账号密钥或云模型。

- 全量离线回归：1,188 项，1,188 通过，0 失败，0 取消，0 跳过（明确启用标准 venv 中的 Pillow，两个动图集成用例实际执行）。公开模板专项 12 项、运行时权限/能力专项 14 项及新增 Codex 期限专项 3 项全部通过，覆盖模型 API、插件、面板、人格本地副本、TTS/vision 门控及撤权取消；最终 clean-checkout 结果仍由 CI 和发布验收复核。
- 实际本机 HTTP 服务验证 OpenAI-compatible 请求 URL、Bearer、模型、JSON schema 提示、两种 token 字段、可省略 response_format、超时/取消和坏结构拒绝；使用虚构密钥和合成响应；另以完全未设置密钥的实际 loopback HTTP 请求验证无 Authorization 本机模型，远程 HTTPS 无密钥在发请求前拒绝。
- Codex 的 modelProvider.timeoutMs 已验证实际传入计时器，保留旧配置的模式默认；150ms 期限实际终止独立的无模型 Node 子进程，没有调用真实 Codex/云模型。
- Codex 必须同时收到完整 agent_message 与 turn.completed 才提交最终答案，并在保存 usage 后清理计时器、取消监听及子进程；部分输出、取消、失败和坏结构不会提前返回。旧 CLI 的零退出码加完整答案路径仍兼容。新增 11 项协议/回收用例，含实际惯性 Node 子进程；模型/API/权限合并专项 61 项全部通过。尚未观察到进程退出码的成功提交记录 exit_code=null，迟到事件不会重复记账。
- localhost 面板 CSRF、Origin、配置持久化、无密钥回显、人格 local overlay 默认卡不变均通过。
- 独立无界面 Edge profile 实际操作面板：模型高级字段、多行别名/群白名单、人格保存和 Mock 试聊正常，零页面错误；没有接管用户浏览器或桌面。
- `demo --smoke` 实际请求管理页和 Mock 生成接口，成功后退出；`doctor --json` 对未配置账号报告 needs_setup 并正常退出。
- 发布扫描未发现私人数据规则命中；不把扫描代替人工审查。

两个可选动画用例已用标准 venv 实际执行通过，覆盖 GIF/WebP 像素采样、帧数/尺寸、临时 PNG 清理、会话归属与静态发送回退。解码不再要求 `runtime/python_packages`；测试在没有该目录且工作目录存在同名 `PIL.py` 的新项目夹具中通过，验证 `-I` 使用所选 venv 的依赖而不从工作目录导入。`XIAOKE_PYTHON_PATH` 在调用时读取，支持客户端加载本地 `.env` 后生效。未配置该解释器的基础安装仍会明确跳过这两项可选集成；不能据此推断该部署已具备媒体能力。这次公开副本没有真实 QQ 权限、真实模型服务或 Linux 机器验收，跨系统 CI 矩阵会分别执行，平台账号仍需部署者按版本和权限完成验收。
## QQ 入站语音

Windows、Node 24 和已安装的中文桌面识别器实测通过。用同一条合成中文短句分别生成 PCM WAV 和 QQ SILK，两次都识别出了原句。公开模板的 `node --test "test/*.test.mjs"` 共 1199 项通过；发布扫描检查了 250 个候选文件。

`node --test test/incoming_voice.test.mjs test/safe_media_fetch.test.mjs test/qq_startup_recovery.test.mjs` 可重放缓存、撤销授权、超时、错误格式及端到端群聊和私聊。网关测试实际启动服务，接入本机合成的 QQ 事件、音频下载与收件端，验证转写里的配对口令、审批及浏览请求只进入聊天。该测试使用 Mock 回答；口音、远场噪声和真实 QQ 设备录音仍取决于部署的识别器。

未听清语音的处理另有 `node --test test/unheard_voice.test.mjs` 五项回归，覆盖私聊重放、群内 @、旁聊静默、附带文字或引用及其他账号。合成 QQ 网关还分别让私聊／群聊语音经过实际下载和 ASR 空结果，再核对原消息收到本地澄清。完整套件已增至 1,204 项。
