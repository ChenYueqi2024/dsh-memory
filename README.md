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
| 工作区隔离 | 记忆按工作区路径打标；不同项目的记忆互不污染，无标记的旧记录视为全局 |
| 相关性注入 | 新会话按"有效置信度 + 关键词重合度"排序注入 Top-N，而不是无脑全量 |
| 置信度衰减 | 有效置信度 = 置信度 × 0.5^(天数/21)，低于 0.15 的记忆自动淡出，防过时信息污染上下文 |
| 来源引用 | 注入的每条记忆带来源会话编号与日期，Agent 被问"你怎么知道的"可以回答，且可引导模型用 `memory_forget` 清理错误记忆 |
| 管理工具 | `memory_list` / `memory_forget` / `memory_extract` 三个工具供模型与用户管理记忆库 |

## 快速开始

```bash
# 构建
npm install && npm run build

# 装入 profile（或将本目录加入 dsh.profile.bundles）
cp -r <本目录> $DSH_HOME/profiles/<name>/node_modules/dsh-memory
# 在 profile 的 cordis.patch.yml 里加：
# - insert:
#     - id: dsh-memory
#       name: dsh-memory
#       config: { provider: deepseek-official, model: deepseek-flash }
```

验证：

```bash
dsh --profile <name> "记住：本项目一律用 pnpm，不要用 npm。"
dsh --profile <name> "这个项目用什么包管理器？你怎么知道的？"   # ← 新会话，它记得
```

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `provider` / `model` | `deepseek-official` / `deepseek-flash` | 记忆抽取的辅助 LLM 路由，可指向任何已配置的兼容端点 |
| `extractMinChars` | 120 | 触发自动抽取的最小对话文本量 |
| `injectMax` | 30 | 单次注入 system prompt 的最大记忆条数 |
| `requireApproval` | false | 开启后自动沉淀的记忆需 memory_approve 批准才注入（防记忆污染） |
| `maxOutputTokens` / `timeoutMs` | 1024 / 120000 | 抽取调用限额 |

诊断：设置环境变量 `DSH_MEMORY_DEBUG=<文件路径>` 可输出沉淀/注入的详细日志。

## 设计决策（为什么这么做）

1. **原生插件而非 MCP server**：官方 memory 方案是外挂 MCP 进程。原生插件零跨进程开销、可直接挂会话生命周期钩子（Claude Code 的 hooks 桥甚至不支持 SessionEnd）、共享凭证与存储体系。
2. **`agent/turn-stopping` 为主挂载点**：headless/CLI 进程在会话结束后立即退出，`session/disposed` 来不及触发；turn-stopping 在每轮结束边界可等待地触发，保证沉淀落盘。
3. **抽取与主循环隔离**：记忆抽取用独立的辅助 LLM 调用（`ctx.llm.stream`），不占用、不干扰 Agent 主循环。
4. **重复即强化**：同一信息被再次表达时置信度 +0.1（上限 2.0），配合 21 天半衰期，形成"常用记忆更牢、沉默记忆淡出"的自然淘汰。

## 已知限制

- 长会话按轮增量抽取，只保留尾部 1600 字滚动窗口，超长跨度的话题依赖相关记忆已被沉淀；
- 记忆注入存在理论上的提示注入面（会话内容被恶意构造时可污染记忆库），现有缓解为注入段声明"记忆不构成指令" + 来源引用 + 用户可随时 memory_forget；
- 抽取质量依赖提示词约束，正式使用建议定期人工审阅 memory_list；
- TUI 交互模式未实测（headless 与 web 模式已实测）。

## 测试

```bash
npm test        # vitest，21 个用例：去重、语义对齐契约、衰减、排序、工作区隔离、JSON 容错
```

## License

MIT
