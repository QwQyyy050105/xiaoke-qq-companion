---
name: verify-bot-release
description: Verify this bot template from a clean source export before release, including offline installation, actual local protocol paths, privacy and handoff evidence.
---

# Verify a bot release

先读仓库根 AGENTS.md、README、CONTRIBUTING.md；仅为发布或有必要的完整验收使用，不给小文案修改增加全量流程。

从将发布的提交或候选文件建立干净工作目录，记录 commit 或文件清单哈希。不要复制 node_modules、账号文件、私人媒体或运行状态；防止从上级目录借到依赖。使用 package.json 支持的 Node。

运行 npm ci、npm test、npm run demo -- --smoke、npm run doctor -- --json、npm run check:release。将可选 skip、失败与退出码如实记录，缺账号的 doctor 不等于真实连接。功能变化另外测试实际本地 HTTP/WebSocket/面板路径和保存后重读；已有检查通过后不无故重复扩大测试。

审核暂存区与首次发布的全部历史，检查许可证、密钥、真实人物/群标识、绝对路径、个人媒体及状态文件。npm audit 发现问题时评估和修复支持范围内的依赖，再运行相关回归；不要盲目 --force。

真实账号、实际模型和应用版本另列验收结果；未验证不写成支持。发布使用现有用户授权，认证失效时保留可审阅产物并指出所需的人类操作。不要自动更换账号、模型或公开目标。

完成报告写明源版本、系统/Node、命令、通过/失败/skip、隐私扫描、真实验收边界和剩余动作。清理本次生成且已被替代的临时文件，保留必要证据与唯一源码。
