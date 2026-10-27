# 本地验收边界

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
