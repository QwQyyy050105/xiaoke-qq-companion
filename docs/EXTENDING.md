# 扩展契约 v1

核心使用 QQ 官方机器人 API。它不接管个人 QQ，不依赖桌面 QQ 的窗口、客户端版本或输入焦点。事件权限、群内消息范围、审核和主动消息额度仍由腾讯决定。先检查官方后台的能力，再选扩展。

## 模型

`config.local.json` 的 `modelProvider` 支持真实的三条路径：

```json
{"type":"openai-compatible","baseURL":"https://your-provider.example/v1","model":"your-model","envKey":"MODEL_API_KEY","timeoutMs":60000,"maxOutputTokens":1200,"tokenLimitField":"max_tokens","responseFormat":"json_object"}
```

密钥只放 `.env` 或进程环境。HTTP 实际调用 `${baseURL}/chat/completions`，使用 `messages`；远程 HTTPS 需要环境密钥并使用 Bearer 认证。只有精确 `localhost`、`127.0.0.1`、`[::1]` 的 HTTP 端点允许无密钥，未设置时完全省略 Authorization，不要求 dummy key；`tokenLimitField` 可选择 `max_tokens` 或 `max_completion_tokens`。`responseFormat=prompt` 省略 `response_format`，保留提示词和运行时 JSON 校验；默认 `json_object` 的结构化回复请求 `response_format: {type: "json_object"}`。模型必须支持 JSON 对象；API 返回先验证 envelope，再经过 `parseChatResponse`/`parseSocialResponse` 等现有解析器。错误不会附带原始响应、凭据或提示词。请求支持超时、AbortSignal、最大 2 MiB 响应、3张图片（单张8 MiB、合计16 MiB）和禁止重定向。API 模式没有内置实时搜索；可安装 search 扩展，宿主显式调用它并把证据放入会话输入。不要把模型声称联网当成工具调用。

`mock` 完全离线，回显输入用于验证接收/配置/解析链路，不代表真人聊天质量。`codex` 需另装可用 CLI 和账号，由 `CODEX_CLI_PATH` 指定；不替用户注册、购买或更换模型。不写死私人模型名称或安装位置。Codex 与 API 都使用面板 `modelProvider.timeoutMs`（100–180000 ms）；显式设置覆盖模式默认。旧配置未提供 timeoutMs 时，Codex 保留 routing 20秒、文字60秒、带图90秒、后台/专用任务150秒。取消仍立即结束本次子进程，不等到超时。

直接调用：

```js
import {chatGenerator} from './src/model_client.mjs';
const generate = chatGenerator(process.cwd(), config);
const answer = await generate({text:'你好', history:[], memory:[], signal:AbortSignal.timeout(10000)});
console.log(answer.reply);
```

## 插件

仅由本机维护者在 `plugins` 配置相对模块路径，保存后重启加载。允许 `./plugins/*.mjs` 和 `./examples/**/*.mjs`，解析真实路径并拒绝越界。JS 插件具有宿主进程的本机权限，**不提供沙箱**；先审查再启用。群聊和模型不能安装插件。配置不会携带 `.env` 密钥给插件，但插件本身作为可信代码仍能读取进程环境。

```js
export default {
  apiVersion: 1, id: 'my-style', capabilities: ['beforeGenerate'],
  setup(context) {
    // context = {apiVersion, root, config, log}
    return {beforeGenerate: async input => ({...input, chatSettings:{...input.chatSettings, style:'简短'}})};
  }
};
```

| 能力 | 函数形状 | 核心接入 |
|---|---|---|
| beforeGenerate | `(ConversationInput) => ConversationInput` | 每次生成之前，含真实 QQ 和本地聊天 |
| afterGenerate | `(ChatResult) => ChatResult` | 每次生成之后，保持结构化字段 |
| chat | `(ConversationInput) => ChatResult` | 可替换生成器，结构化结果校验后才交付 |
| vision | `(request) => {status, description, ...}` | 可调用契约；默认 unsupported；API 模型另支持真实附图 |
| asr | `(request) => {status, text, ...}` | 可调用契约；默认 unsupported；未自动接 QQ 音频 |
| tts | `(request) => {status, ...}` | 可调用契约；默认 unsupported；未自动合成/上传 |
| search | `(request) => {status, results, ...}` | 可调用契约；默认 unsupported；未自动规划工具循环 |

后四项是明确的扩展接口，不宣称已完成自动媒体链路。调用 `extensions.call('asr', request)` 未配置时返回 `{status:'unsupported', capability:'asr'}`。配置示例 `plugins:["./examples/plugins/greeting.mjs"]` 实际进入 `beforeGenerate`。每项独占能力拒绝重复提供者；前后钩子按配置顺序执行。

## 更多平台与设备

传输层集中在 `QQClient`；保留事件归一化、发送回执、取消和队列接口可接其他设备适配器，不需要改人格/模型。Windows、Linux、macOS 的 Node 22+ 可运行核心和面板。浏览器渲染、动图解码、TTS 和原生图像生成属于可选运行环境，必须显式配置；模板不下载权重、不自动启动 GPU。`runtime/owner_browser_runtime.json` 可指定浏览器，`XIAOKE_PYTHON_PATH` 可指定 Python；缺少时报告 unavailable。私有部署遗留的共享语音适配器默认指向项目 `runtime/shared_voice`，无配置保持禁用，建议新集成走 v1 插件。

## 面板和兼容性

`npm run panel` 只配置不连接 QQ，默认 `http://127.0.0.1:8794`。`npm start` 的面板由实际进程提供。`GET /api/config` 读取非密钥配置；`POST /api/config` 合并顶层字段，统一验证后原子持久化，下次生成使用新模型/语气/会话范围。角色在 `/api/roles`，角色卡是唯一人格来源：优先读取被 Git 忽略的 `character_card.local.json`，不存在时读取分发默认 `character_card.json`；面板保存只写 local，保留默认文件，避免把私人关系误提交。别名、参与方式、静默时段、会话白名单、图片许可可编辑；插件列表须重启。面板仅绑定 loopback，校验 Host/Origin、拒绝跨站请求，写入要求页面下发的 CSRF token。禁止把服务暴露公网。

可运行的独立能力调用示例：`node examples/call_capability.mjs`。它只安装 `mock-search`，输出明确 mock 的合成搜索项，以及未配置 ASR 的 unsupported；不会联网。`npm run demo` 会禁用已有 owner 插件，保证已配置过真实服务的克隆也保持离线。普通 panel/chat/start 才加载配置的受信任插件。

可选执行器的系统限制：现有完整浏览器执行器按 Windows 浏览器二进制校验；其他系统请替换执行器，不把核心能运行视为桌面浏览兼容。腾讯频道 CLI 为额外可选集成，默认寻找项目 runtime 下的 Windows 包，可用 `XIAOKE_CHANNEL_CLI` 指定维护者审核过的程序。未安装时返回 launch_failed，核心 QQ 收发不依赖它。动画采样另需 Python 和安装在该解释器标准虚拟环境中的 Pillow；用 `XIAOKE_PYTHON_PATH` 显式指定 venv 解释器，不需要 `runtime/python_packages`。解码使用 `-B -I`，保留所选 venv 的 site-packages，同时排除工作目录、用户 site 和 PYTHONPATH，图片字节只通过 stdin 输入。模板不自动安装 Python、浏览器、CLI 或模型。

## 运行时能力与撤销授权

人格和历史不能开启能力。生成器每轮从媒体开关、可选执行器和实际项目文件得出 `runtime_capabilities`：未装排版浏览器、频道 CLI 或生图参考/运行环境时，模型得到 unavailable 和文字降级说明，不能把模板中存在代码当作当前已可执行。已配置也不等于已登录或已成功，仍需真实工具和发送回执。

TTS 开关从模型输入、回复计划、主动发言一直检查到共享语音执行器。关闭会取消在途合成并禁止状态刷新/加载/生成；已有语音目录与动态 TTS 分开。关闭 vision 时不准备临时图片，中途关闭会释放已准备文件。

面板保存新的会话范围后，会轮换进程内授权 epoch、中止在途模型调用、清理待处理聊天和派生提取任务。QQ 的实际 HTTP 请求在等待 token、图片或语音准备之后再次检查目标和当前授权。被撤销的旧结果即使在重新授权后返回，也不能发送。已经提交给 QQ 的请求仍可能送达；此时保留 uncertain，不承诺撤回、不自动补发。后台记忆按任务自身的 room hash 定位当前授权会话，词语研究保留原事件授权，不借用另一段异步任务的身份。取消派生任务保留已保存的聊天与记忆；删除资料另用对应命令。


可选动画解码器安装示例（在仓库根目录执行；路径保留在本项目）：

```powershell
python -m venv runtime/media_venv
./runtime/media_venv/Scripts/python.exe -m pip install Pillow==13.0.0
$env:XIAOKE_PYTHON_PATH=(Resolve-Path ./runtime/media_venv/Scripts/python.exe).Path
npm test
```

macOS/Linux 使用 `runtime/media_venv/bin/python`，在运行进程前 `export XIAOKE_PYTHON_PATH="$(pwd)/runtime/media_venv/bin/python"`。客户端也可在本地 `.env` 设置绝对解释器路径；`npm test` 的可选集成用例读取当前进程环境，需要在终端明确设置变量。Pillow 13.0.0 已用于本地实际 GIF/WebP 验收；其他版本需自行运行集成用例。未配置时基础聊天仍可运行；已配置但缺少 Pillow 会返回 media_decoder_failed，不会读取私人依赖目录或自动安装软件。
