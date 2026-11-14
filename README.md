# dsh-memory

![test](https://github.com/ChenYueqi2024/dsh-memory/actions/workflows/test.yml/badge.svg) · [English](README.en.md)

> github.com/ChenYueqi2024/dsh-memory · 配套插件：github.com/ChenYueqi2024/dsh-commit
> 项目主页：https://chenyueqi2024.github.io/dsh-memory/

给 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness)装上**跨会话项目记忆**的原生插件。

dsh 的每次会话都是失忆的：项目约定、技术决策、用户偏好要么靠人工维护 AGENTS.md，要么每次重新交代。dsh-memory 让 Agent 在对话中**自动沉淀**值得记住的信息，并在未来的会话里**自动想起**。

```
会话进行中 ──事件流──▶ 文本积累器
                          │ turn 结束（可等待钩子）
                          ▼
              LLM 记忆抽取（一次辅助调用，JSON 输出）
                          │
              语义去重（精确匹配 + 词项包含度 0.65）
                          ▼
              存储域 dsh_memory（官方 JSON 后端，按工作区隔离）
                          │
新会话启动 ──▶ agent/created ──▶ 按当前问题相关性检索
                          ▼
              注入 system prompt「项目长期记忆」段（带来源引用）
```

## 功能

| 能力 | 说明 |
|---|---|
| 自动沉淀 | 每轮结束（`agent/turn-stopping`）自动抽取本次对话中的决策/约定/偏好/事实；`session/disposed` 与 `memory_extract` 工具作为兜底路径 |
| 语义去重 | 措辞不同的重复信息（如"用中文回答" vs "用户要求中文回答"）合并为一条并**提升置信度**——重复即强化 |
| 工作区隔离 | 注入、查询、批准和删除仅访问当前工作区及全局记忆；自动抽取只更新当前工作区，无标记的旧记录视为全局 |
| 相关性注入 | 新会话按"有效置信度 + 关键词重合度"排序注入 Top-N，而不是无脑全量 |
| 置信度衰减 | 有效置信度 = 置信度 × 0.5^(天数/半衰期)，半衰期按类别（fact 14 天 / decision·convention 30 天 / preference 45 天），低于 0.15 的记忆自动淡出，防过时信息污染上下文 |
| 来源引用 | 注入每条记忆的条目编号与最近创建/强化日期（`#编号 - 日期`）；存储记录另保留最初的 `sourceSessionId`。编号不是会话编号，日期也不是不可变的原始证据时间 |
| 管理工具 | `memory_list` / `memory_forget` / `memory_extract` / `memory_approve` 四个工具供模型与用户管理记忆库 |

## 快速开始

```bash
# 在源码目录安装；prepare 自动构建 dist/index.js
npm ci && npm test

# 装入 profile（或将本目录加入 dsh.profile.bundles）
cp -r <本目录> $DSH_HOME/profiles/<name>/node_modules/dsh-memory
# 在 profile 的 cordis.patch.yml 里加：
# - insert:
#     - id: dsh-memory
#       name: dsh-memory
#       config: { provider: deepseek-official, model: deepseek-flash }
```

Git 托管安装会执行 `prepare`。使用 `dsh plugin --profile <name> add github:ChenYueqi2024/dsh-memory` 时，如 pnpm 报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，将它打印的**精确包名和 Git 哈希键**加入该 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds`，保留文件原有设置后重试；不要全局放行所有安装脚本。插件使用 dsh 0.2.0-rc.2 提供的运行时依赖（其中 Cordis 为 4.0.4，不能把它写成 dsh 的版本号）。

验证：

```bash
dsh --profile <name> "记住：本项目一律用 pnpm，不要用 npm。"
dsh --profile <name> "这个项目用什么包管理器？你怎么知道的？"   # ← 新会话，它记得
```

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `provider` / `model` | `deepseek-official` / `deepseek-flash` | 记忆抽取的辅助 LLM 路由，可指向任何已配置的兼容端点 |
| `extractMinChars` | 120 | 触发自动抽取的最小对话文本增量 |
| `autoExtractMinIntervalMs` | 90000 | 同一会话两次自动（轮末）抽取的最小间隔；各会话独立计时，间隔内的增量累积到下一次合格轮次 |
| `injectMax` | 30 | 单次注入 system prompt 的最大记忆条数 |
| `requireApproval` | false | 开启后自动沉淀的记忆需 memory_approve 批准才注入（防记忆污染） |
| `maxOutputTokens` / `timeoutMs` | 1024 / 120000 | 抽取调用限额 |

诊断：设置环境变量 `DSH_MEMORY_DEBUG=<文件路径>` 可输出沉淀/注入的详细日志。

## 设计决策（为什么这么做）

1. **原生插件而非 MCP server**：官方 memory 方案是外挂 MCP 进程。原生插件零跨进程开销、可直接挂会话生命周期钩子（Claude Code 的 hooks 桥甚至不支持 SessionEnd）、共享凭证与存储体系。
2. **`agent/turn-stopping` 为主挂载点**：headless/CLI 进程在会话结束后立即退出，`session/disposed` 来不及触发；turn-stopping 在每轮结束边界可等待地触发，保证沉淀落盘。
3. **抽取与主循环隔离**：记忆抽取用独立的辅助 LLM 调用（`ctx.llm.stream`），不占用、不干扰 Agent 主循环。
4. **重复即强化**：同一信息被再次表达时置信度 +0.1（上限 2.0），配合按类别差异化衰减（fact 14 天 / decision·convention 30 天 / preference 45 天），形成"常用记忆更牢、沉默记忆淡出"的自然淘汰。
5. **审批准入（可选）**：`requireApproval` 开启后，自动沉淀的记忆待审批且不注入；冲突替代关系随候选保存。抽取结果没有新旧事实的一一映射，因此同批替代候选全部存在且获准后才退役旧事实；删除某个候选会保留旧事实，可显式重新抽取或手动清理。显式 `memory_extract` 视为授权，重复合并和强化也会批准已有待审批条目。审批工具仍由模型调用，这不是独立的人类身份认证或安全沙箱；自动抽取只有 supersede、没有替代候选时，不执行该待审批变更。
6. **三条沉淀路径协调**：轮末自动、会话结束兜底按未处理增量触发；显式工具可再次提取当前缓冲区。同一会话中的抽取协调执行，只有成功后推进游标；调用或存储失败保留文本供下一次合格触发重试。会话结束后没有持久重试队列。生命周期回归覆盖工作区、重试、限频和兜底去重。
7. **自动抽取有频率节制**：每轮新增文本达标就抽一次听起来合理，但那是每轮一次付费调用还要在轮次边界 await；90 秒最小间隔让增量自然累积，长会话不为每轮重复付费。
8. **工作区与编号约束在执行时检查**：工具拒绝无会话及子 Agent 调用，只读写当前工作区和全局记录；全局记录仍可被用户通过工具批准/删除。自动抽取只接受本工作区有效记忆的唯一编号，不允许模型返回其他工作区、全局或已退役编号来改写它们。空编号和歧义前缀不执行修改。
9. **旧事实恢复与落盘顺序**：历史已取代记录不参与去重，重新生效的旧约定创建新记录；新事实写入成功前不退役旧事实。存储 schema v5 兼容读取 v1–v4；开始写入 v5 后，回滚旧插件应配合恢复旧数据备份。

## 已知限制

- 长会话按轮增量抽取，只保留尾部 1600 字滚动窗口，超长跨度的话题依赖相关记忆已被沉淀；
- 记忆注入存在理论上的提示注入面（会话内容被恶意构造时可污染记忆库），现有缓解为注入段声明"记忆不构成指令" + 来源引用 + 用户可随时 memory_forget；
- 抽取质量依赖提示词约束，正式使用建议定期人工审阅 memory_list；
- TUI 交互模式未实测（headless 与 web 模式已实测）。

## 测试

```bash
npm test        # vitest，45 个用例：存储/解析 + 插件入口、工具执行、抽取与生命周期接线
```

生命周期测试仅替代宿主注册/schema/LLM 分块边界，其余运行生产代码，无需 API key。真实宿主验证另运行：

```bash
node scripts/verify-host.mjs <隔离profile目录> <安装了dsh的目录> <全新的测试存储目录>
```

该脚本需 profile 已安装两个插件且可解析宿主依赖，使用真实 Cordis Loader、schema、工具定义、LLM 分块组装和 JSON 后端，跨三次启动验证持久化、审批、隔离、来源格式与删除。LLM 输出由固定夹具提供，不代表真实模型抽取质量或完整 CLI/Web/TUI 端到端验证。不要把测试存储指向日常记忆库。

## 对照评测

[评测协议与运行说明](evaluation/README.md) 提供无插件、冻结的静态 AGENTS.md、dsh-memory 三组对照：20 个主案例＋4 个独立审批/删除诊断，统一输入、评分和成本记录。`npm run test:eval` 为独立的离线脚本自检；`node evaluation/run.mjs --mode plan` 查看调用预算。

[2026-11-14 完整实验报告](evaluation/reports/2026-11-14-full-evaluation.md)：20 个固定合成主案例各重复 3 次，无插件/静态文件/插件分别答对 **15/60、51/60、60/60**。插件比冻结文件多答对的 9 次全部来自约定变更；其主实验 token 用量也约为静态组的 **5.73 倍**。独立治理诊断 12/12。实验不是完整 Agent 任务评测，不代表一般真实任务准确率，也没有比较持续人工维护的 AGENTS.md；成本、原始证据哈希和限制见报告。

## License

MIT
