# 三组对照评测协议 v1.0.0

版本边界：下述已完成的真实模型结果来自 **v0.4.1**。v0.5.0 的用户指定持久记忆使用单独的确定性时间/存储测试；本轮 smoke 不构成新增质量或成本证据。当前宿主接线通过检查必要工具存在，兼容新增 memory_pin，不改原案例、评分和报告。

本目录提供固定案例、隔离运行器、评分器与离线自检。**2026-11-14 首轮全量三轮实验已完成并复核。** [完整报告](reports/2026-11-14-full-evaluation.md)：20 个固定主案例×3 次，无插件 15/60、冻结静态 AGENTS.md 51/60、dsh-memory 60/60；独立治理诊断 12/12。全部 306 次请求合计 89,057 tokens；插件主实验 token 用量为静态组约 5.73 倍。结果仅适用于本组合成案例，不代表持续人工维护静态文件的对比结论或一般真实任务准确率。`smoke` 的质量和用量始终为 null，不属于效果证据。

小试验 `runs/live-1794629675063/`：recall-package 一次重复，memory/static 均正确回答 pnpm，none 回答 UNKNOWN；4 次成功请求、983 输入＋76 输出＝1,059 tokens。实际记忆落盘及新上下文引用已核对，抽取内容有历史支持。案例、评分、源码及评测器哈希均与 manifest 一致。该单例仅确认调用链路，不能证明整体效果或优于静态文件；不并入后续正式三轮统计。原始结果保留在本地忽略目录，不修改。

## 实验问题与公平边界

在相同项目历史和新会话问题下，自动维护的记忆能否保留、更新正确的项目知识？为此比较以下三组：

| 组别 | 新会话可见资料 | 历史如何保留 |
|---|---|---|
| `none` 无插件 | 统一回答指令＋问题 | 历史已结束，不保留资料 |
| `static` 静态 AGENTS.md | 同样指令＋当前工作区文件＋问题 | 人工整理的正确初始快照，之后冻结 |
| `memory` dsh-memory | 同样指令＋生产插件实际注入段＋问题 | 重放历史，通过实际抽取、存储、更新、审批路径维护 |

静态组不是空白或故意写错的文件：初始事实完整，按工作区隔离；其中变更组会让静态快照过期，恢复旧约定的案例则允许静态组再次答对。**结果仅能比较“冻结文件”与自动维护，不能推出插件优于持续人工维护的 AGENTS.md。** 人工整理时间没有测量，不折算成本。

这是**受控上下文实验**：真实 Cordis Loader、实际插件 dist、真实存储域与 JSON 后端；替代应用侧工具/提示词注册表和模型传输。统一模型直接回答最终问题，不开放工具，不启动完整 CLI/Web/TUI，不评测自主任务完成率。历史均为人工编写的用户说明＋同一句“已收到本次项目说明。”；不会使用某一组生成的回答作为另一组历史。

## 案例与预先约定的评分

`cases.json` 只有输入与操作，`rubric.json` 单独保存答案和结构性检查。评分标准不进入任何模型消息。

| 范围 | 数量 | 目的 |
|---|---:|---|
| recall | 4 | 包管理器、虚构代号、端口、测试命令的跨会话召回 |
| paraphrase | 4 | 同义重述后仍能回答，检查有效记录是否为 1 条 |
| update | 4 | 技术约定变化、发布日变化以及旧约定重新生效 |
| isolation | 4 | 两个工作区知识隔离，B 的更新不改写 A |
| abstention | 4 | 未决定、假设、临时任务和引用恶意样例时应答 UNKNOWN |
| 独立诊断 | 4 | 待审批不注入、批准后可见、删除后遗忘、部分替代候选获准不退役旧事实 |

前 20 例分别运行三组；后 4 例仅运行 memory，**不混入三组主准确率或主成本**。诊断中的审批和删除是运行器预定操作，并不证明模型有良好审批判断或存在独立的人类授权边界。目标选择器必须唯一匹配实际记录，否则记为执行错误。

默认每例每组重复 3 次；同一 repeat 的三组配对比较。SHA256 排序＋固定 seed 随机化单元执行顺序，案例内历史顺序不变。案例公开且为合成数据，无独立留出集，重复调用也不等于独立样本；不报告显著性或泛化结论。第一次真实调用前冻结案例/评分版本和哈希；之后若为修复问题而修改，递增协议版本并重新跑全组，保留失败结果，不能只报告最好一轮。

指标定义：

- **准确率**：JSON `answer` 与预定义别名精确匹配，允许 NFKC、大小写及空白归一化。混合新旧答案、额外解释不通过。失败/跳过单元计入计划分母；另列完成、错误、跳过及 JSON 格式失败数量。`byCategory` 给出每类结果，避免仅凭总分掩盖冲突更新失败。
- **无依据作答率**：标准答案为 UNKNOWN、调用成功且格式合法的样本中，回答非 UNKNOWN 的比例；同时报告分母，不能把格式错误当作正确拒答。主要衡量回答污染，不等同于记忆库所有条目的事实错误率。
- **引用有效率**：正确的非 UNKNOWN 回答中，至少有一个来源且全部来源标识存在于注入段/AGENTS.md。编号存在不代表内容蕴含答案。UNKNOWN 必须不带来源。
- **结构诊断**：指定案例检查 active/pending/superseded/total 数量，结果在逐例 `score.memoryChecks`。这些是去重、更新和治理的代理检查，不是语义质量判定；额外的合理事实也可能导致严格数量检查失败，需要查看原文。
- **配对结果**：memory 独对、基线独对的数量，失败按未答对处理；存在跳过时不输出配对结论。
- **调用、token、延迟**：逐次保存真实 provider usage；缺失用量列入 `usageMissingCalls`，总和仅为已观测部分。主成本含 memory 历史抽取＋最后回答；诊断成本单列。保存每次调用、历史阶段和整单元耗时；摘要列抽取/回答中位延迟。没有价格、人工时间或未测 token 估算。

真实运行后还应逐条人工审阅 `results.json` 的记忆与 `calls.jsonl` 的原始抽取文本，把条目标为“有历史支持／无支持／不明确”，报告无支持数量、审阅总数及典型失败；不要把自动数量检查包装成“错误记忆率”。

## 离线执行

Node 22，无新增 npm 依赖。PowerShell 从仓库目录执行：

```powershell
Set-Location D:\dev\dsh-lab\dsh-memory
npm run test:eval
node evaluation/run.mjs --mode plan
npm run build
node evaluation/run.mjs --mode smoke --repeats 1
```

`plan` 和 `test:eval` 无需宿主、凭证或联网，适合 CI。`smoke` 需要本地已安装的 dsh 宿主；默认使用仓库上一级目录，可用 `--host <安装了dsh的目录>` 指定。离线传输仅从历史文本机械生成候选，没有答案表访问权限，不模拟语义去重/冲突判断；它只验证完整调用链能运行。

每个 case/group/repeat 使用独立工作区和存储目录，训练后销毁 Cordis 上下文，再从磁盘启动新上下文回答。不会读取日常 profile 的历史或记忆，也不需要 DSH_HOME；运行器清除 DSH_MEMORY_DEBUG，避免沿用调用者的日志路径。

为压缩实验时长，插件配置仅在实验中设 `extractMinChars=1`、`autoExtractMinIntervalMs=0`；其余明确固定为 injectMax=30、抽取最多 1024 输出 token、120 秒超时、requireApproval 按案例。每段历史恰好触发一次轮末抽取，个别诊断走显式工具；不额外触发 disposed 兜底。新问题用于检索，但回答后不再次沉淀。此设置不代表默认 120 字/90 秒配置下的实际调用频次。

## 真实模型调用与 API Key

当前适配 [DeepSeek 官方 Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion)：固定 `https://api.deepseek.com/chat/completions`，模型默认 deepseek-flash，temperature=0、thinking disabled、JSON object、非流式。回答限 256、抽取限 1024 输出 token。所有组使用同一模型和参数；保存实际返回的模型名与 fingerprint（若提供）。上述参数已在本次小试验的四次真实调用中验证；不同账户的可用性仍需自行确认。

先在 [DeepSeek 平台](https://platform.deepseek.com/) 创建可用的 API Key；它与 GitHub token 是不同凭证。**不要把 Key 发进聊天、写入 .env、profile、脚本或命令行字面量，也不要使用 setx。** 提供的脚本用隐藏输入把 Key 临时放到当前进程环境，再传给 Node；若由脚本输入，退出时删除。已有 DEEPSEEK_API_KEY 则沿用，不主动保存或修改持久环境。

先跑一个案例（无插件、静态、记忆三组共 3 次回答＋1 次抽取 = **4 次请求**）：

```powershell
Set-Location D:\dev\dsh-lab\dsh-memory
powershell -NoProfile -ExecutionPolicy Bypass -File .\evaluation\run-live.ps1
```

`ExecutionPolicy Bypass` 仅作用于这个 PowerShell 进程。脚本先显示预算，再隐藏提示输入 Key。若成功且预算可接受，再跑正式全量：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\evaluation\run-live.ps1 -Full -Repeats 3
```

全量：192 个单元、192 次回答＋114 次抽取 = **最多 306 次请求**，输出 token 配置上限 165,888；这不是实际消耗或费用，输入 token 不包括在该上限中。单次重复为 64 单元、102 次请求。temperature=0 也不保证完全确定，仍保留重复实验。

脚本没有自动重试。HTTP 错误、网络错误、截断或缺内容会停止后续请求并将剩余单元标为 skipped；应用侧错误保留该单元错误，继续其他单元。日志不记录 Authorization 或原始网络异常，不跟随重定向；输出额外剔除环境中的完整凭证字串。调用耗时包含实际 API 等待；没有刻意禁用服务端缓存，usage 保留缓存字段。

用户在另一终端设置的环境变量不会自动传入已打开的 Codex；在输入 Key 的同一终端直接执行上述脚本即可。运行后提供结果目录供分析，不需要提供 Key。缺 Key 时 live 在创建结果文件和发请求前退出。

## 结果与复核

默认在 `evaluation/runs/<mode>-<时间戳>/`，已 gitignore；`--out` 可改为新的独立目录，已有目录拒绝覆盖。不要用日常记忆库作为输出目录。

| 文件 | 用途 |
|---|---|
| manifest.json | 协议/案例/评分/源码/构建/评测器哈希、Git HEAD、宿主/Node 版本、参数与完整调度 |
| calls.jsonl | 不含鉴权信息的实际模型消息、返回原文、finish、usage、延迟；两阶段均留痕 |
| results.json / results.csv | 逐例上下文、回答、记忆快照、执行状态、评分、耗时；CSV 为精简表 |
| summary.json / REPORT.md | 机器可读汇总与可阅读摘要；明确区分 smoke 和 live |
| cells/ | 各单元的静态文件和实际插件 JSON 存储 |

离线 smoke 的 64/64 完成只能证明运行链路可用，不能证明 64 例语义通过。真实失败应结合调用原文判断是抽取遗漏、重复未合并、退役错误、检索遗漏、回答错误还是格式错误；报告失败原文和原因，修复后作为新的实验版本运行，不能覆盖旧证据。提交报告前检查数据只包含这些合成案例。

## 发布凭证

本阶段不推送，也不需要 GitHub token。后续推送时使用另一个临时凭证：按 [GitHub 官方 PAT 说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)，创建仅限 dsh-memory 与 dsh-commit 的 fine-grained token，Contents: Read and write；因为本次修改 workflow，还需要 Workflows: Read and write。无需 Administration 权限。届时通过临时进程环境和不落盘的鉴权传递，不能把 token 写进 remote URL、Git 配置或日志；不要用 DeepSeek API Key 推送 GitHub。
