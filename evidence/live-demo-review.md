# 真实 dsh CLI 跨会话演示核验

2026-11-14，独立于正式对照实验的新演示；不加入 306 请求、89,057 tokens 的正式统计。

- 两次实际执行本机 dsh 0.2.0-rc.2，使用本地 dsh-memory 0.4.1 候选版。两个进程均 exit 0，分别耗时 17,857ms、4,876ms，中间停留 7 秒。
- 首次显式调用 memory_extract，保存“本项目唯一包管理器是 pnpm，安装、更新和 CI 都必须使用 pnpm”。轮末也有真实抽取。配置 extractMinChars=40、autoExtractMinIntervalMs=0、requireApproval=false，不代表默认成本。
- 第二次为不同 session ID 的全新启动，系统提示词含落盘记忆，回答 pnpm 并引用 #7fa67757。实际 schema v5 JSON 已批准、属于隔离工作区，sourceSessionId 指向第一会话；第二会话没有工具调用。
- 模型把记忆条目编号称作“前端会话”。这是回答措辞错误，编号实际指向记忆条目；保留原始输出，配音明确解释，没有改写回答。
- Windows gdigrab 捕获本项目窗口失败（error 5）。实际采用 Chrome DevTools 捕获专用网页，网页实时展示子进程 stdout/stderr；共 198 帧，原始时间跨度 40.03 秒，成片约 40.23 秒。保留真实等待时间，没有伪造响应；不是原生终端窗口的桌面截图。
- 后期仅等比例缩放和加下方字幕，中文配音由本机 SAPI Huihui 合成，句级字幕按文本长度估算时序。鲸鱼为项目原创非官方形象，不是口型同步数字人。
- 会话持久化中的 3 个 Agent 响应记录合计 20,436 tokens。此数**不完整**，不含插件抽取与其他宿主辅助调用，不作为演示总成本，也不与正式评测数字相加；没有账单金额。
- 凭证通过隐藏 stdin 进入临时进程及子进程环境，没有保存到项目、脚本、凭证配置或录屏；演示服务已关闭。两个会话解压内容通过凭证形状检查。聊天里已出现的凭证仍建议任务结束后撤销。

证据：live-transcript.json、verification.json、capture-index.json、memory-debug.log，以及 dsh-home 下实际会话与记忆。发布版仅附脱敏演示输出与这份说明，不发布宿主配置或全部会话日志。
