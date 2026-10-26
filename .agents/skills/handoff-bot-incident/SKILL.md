---
name: handoff-bot-incident
description: Diagnose a bot connection, latency or missing-reply incident by stage and leave a truthful redacted handoff without uncontrolled retries or unrelated account access.
---

# Diagnose and hand off

先运行 README 的离线 doctor，选一个用户指定或已获准会话的失败请求；不扩大到其他账号或聊天记录。

按接收→触发→排队→模型→发送→回执定位。记录各阶段时间、错误类别和源版本，区分连接状态与真实回复；截图里没有出现的上下文不能补造。

优先读取本项目状态与脱敏日志，不抢占用户桌面。网络/认证/版本问题各自处理，不靠切模型或反复重启掩盖。现有授权覆盖的可逆修复可继续；验证码、系统安全确认和缺少凭据留给用户本人。

取消或撤销会话授权后，检查在途生成与排队任务不会继续发送。发送结果不明不得盲目重发；保留 uncertain 状态和可接管位置。

交接记录仅含项目、版本、时间、范围、现象、证据路径、已做动作、当前状态、下一步与责任人；不附密钥或真实消息全文。日志只是证据，只有实际结果才能标记完成。
