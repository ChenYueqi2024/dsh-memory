/**
 * dsh-memory: cross-session project memory for DeepSeek Harness.
 *
 * - Accumulates user/assistant text while a session runs.
 * - On session end (or explicit tool call) extracts durable memories via one
 *   auxiliary LLM call and merges them into a storage-domain table.
 * - On every new agent, injects the relevant memories into the system prompt.
 * - Registers memory management tools for the model.
 * @module dsh-memory
 */

import { appendFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z as zod } from 'zod'
import { MemoryStore, formatMemorySection, type MemoryRecord } from './store.ts'
import type { ExistingMemory } from './extractor.ts'
import { extractMemories, TranscriptBuffer } from './extractor.ts'

export const name = 'dsh-memory'
export const inject = ['llm', 'tools', 'storageDomain', 'agents'] as const

/** dsh-memory plugin configuration. */
export interface Config {
  /** LLM provider route used for auxiliary memory-extraction calls. */
  provider: string
  /** Model id used for auxiliary memory-extraction calls. */
  model: string
  /** Extraction output-token cap. */
  maxOutputTokens: number
  /** End-to-end extraction deadline in milliseconds. */
  timeoutMs: number
  /** Minimum transcript characters before automatic extraction runs. */
  extractMinChars: number
  /** Minimum interval between two automatic (turn-end) extractions, in ms. */
  autoExtractMinIntervalMs: number
  /** Maximum memories injected into one system prompt. */
  injectMax: number
  /** When true, auto-extracted memories stay pending until memory_approve. */
  requireApproval: boolean
}

export const Config: z<Config> = z.object({
  provider: z.string().default('deepseek-official'),
  model: z.string().default('deepseek-flash'),
  maxOutputTokens: z.number().step(1).min(64).default(1024),
  timeoutMs: z.number().step(1).min(1000).default(120000),
  extractMinChars: z.number().step(1).min(0).default(120),
  autoExtractMinIntervalMs: z.number().step(1).min(0).default(90_000),
  injectMax: z.number().step(1).min(1).default(30),
  requireApproval: z.boolean().default(false),
})

/** Storage domain: one per-record table of memory rows. */
const memoryDomain = defineDomain({
  name: 'dsh_memory',
  version: 6,
  compatibleVersions: [1, 2, 3, 4, 5],
  layout: 'per-record',
  tables: {
    memories: {
      valueSchema: zod.object({
        id: zod.string(),
        kind: zod.enum(['decision', 'convention', 'preference', 'fact']),
        text: zod.string().max(500),
        createdAt: zod.string(),
        sourceSessionId: zod.string(),
        workspace: zod.string().optional(),
        supersededAt: zod.string().optional(),
        approved: zod.boolean().optional(),
        pinned: zod.boolean().optional(),
        supersedes: zod.array(zod.string()).optional(),
        replacementIds: zod.array(zod.string()).optional(),
        confidence: zod.number(),
        hits: zod.number(),
        lastHitAt: zod.string().optional(),
      }),
    },
  },
})

export async function apply(ctx: Context, config: Config): Promise<void> {
  const log = ctx.logger.bind?.('dsh-memory') ?? ctx.logger
  let store: MemoryStore | undefined
  const transcripts = new Map<string, TranscriptBuffer>()
  const latestQuery = new Map<string, string>()
  const workspaces = new Map<string, string>()
  const lastSeen = new Map<string, number>()
  let failStreak = 0
  let cooldownUntil = 0
  const lastExtractAt = new Map<string, number>()
  const inFlight = new Map<string, Promise<SettleResult>>()

  const ready = (async () => {
    const domain: Domain<typeof memoryDomain> = await ctx.storageDomain.open(memoryDomain)
    store = new MemoryStore(domain.table('memories'))
    return domain
  })()
  ready.catch(error => log.error(`dsh-memory: storage open failed: ${error instanceof Error ? error.message : String(error)}`))

  // ── 1. 沉淀：积累会话文本，会话结束时抽取 ──────────────────────────────
  ctx.on('session/event', (session: { id: string; header?: { cwd?: string; origin?: string } }, event: { type: string; data: any }) => {
    if (session.header?.origin === 'subagent') return
    const cwd = normalizeWorkspace(session.header?.cwd)
    if (cwd) workspaces.set(session.id, cwd)
    if (event.type === 'user/message') {
      const text = collectText(event.data?.content)
      if (text) {
        latestQuery.set(session.id, text.slice(0, 2000))
        if (event.data?.source?.kind === 'user') bufferFor(session.id).add('user', text)
      }
    } else if (event.type === 'assistant/message') {
      const text = collectText(event.data?.message?.content)
      if (text) bufferFor(session.id).add('assistant', text)
    }
  })

  ctx.on('session/disposed', async (session: { id: string }) => {
    const buffer = transcripts.get(session.id)
    const workspace = workspaces.get(session.id)
    try {
      await inFlight.get(session.id)
      if (!buffer || Date.now() < cooldownUntil) return
      const delta = buffer.seen - (lastSeen.get(session.id) ?? 0)
      if (buffer.size() === 0 || delta < config.extractMinChars) return
      await settle('session-end', session.id, buffer, workspace)
    } finally {
      transcripts.delete(session.id)
      latestQuery.delete(session.id)
      workspaces.delete(session.id)
      lastSeen.delete(session.id)
      lastExtractAt.delete(session.id)
    }
  })

  // headless/CLI 进程在会话后很快退出，session/disposed 可能来不及触发；
  // turn-stopping 在每轮结束边界可等待地触发，是自动沉淀的可靠挂载点。
  ctx.on('agent/turn-stopping', async ({ agent }: { agent: any }) => {
    const sessionId: string | undefined = agent?.session?.id
    if (agent?.session?.header?.origin === 'subagent') return
    if (!sessionId) return
    if (inFlight.has(sessionId)) { await inFlight.get(sessionId); return }
    const buffer = transcripts.get(sessionId)
    if (!buffer) return
    if (Date.now() < cooldownUntil) return  // 连续失败退避中，暂停自动抽取
    // 频率节制：自动抽取是付费 LLM 调用且在 turn-stopping 里 await，长会话
    // 每轮都抽既烧 token 又拖慢轮次结束；间隔内的增量累积到下一次合格轮次
    const previous = lastExtractAt.get(sessionId)
    if (previous !== undefined && Date.now() - previous < config.autoExtractMinIntervalMs) return
    // 增量触发：只处理自上次抽取以来新增的文本，避免每轮重复抽取
    const delta = buffer.seen - (lastSeen.get(sessionId) ?? 0)
    if (delta < config.extractMinChars || buffer.size() === 0) return
    lastExtractAt.set(sessionId, Date.now())
    await settle('turn-end', sessionId, buffer, workspaces.get(sessionId))
  })

  // ── 2. 注入：覆盖新 agent，以及热安装前已存在的空会话 ─────────────────
  const promptFibers = new Map<object, { dispose(): Promise<void> }>()
  async function attachPrompt(agent: any): Promise<void> {
    if (agent?.session?.header?.origin === 'subagent') return
    if (!promptFibers.has(agent)) {
      const fiber = agent.ctx.inject(['systemPrompt'], (scope: any) => {
        scope.systemPrompt.section({
          name: 'context:dsh-memory',
          order: 4500,
          text: () => {
            if (!store) return ''
            const workspace = normalizeWorkspace(agent.session?.header?.cwd)
            const memories = store.rankForInjection(config.injectMax, latestQuery.get(agent.session.id), workspace)
            if (memories.length === 0) return ''
            for (const m of memories) store.markHit(m.id)
            const section = formatMemorySection(memories)
            debugLog(`inject(${agent.session?.id}): ${section.replace(/\n/g, ' | ')}`)
            return section
          },
        })
      })
      promptFibers.set(agent, fiber)
    }
    await ready
    await promptFibers.get(agent)
  }
  ctx.on('agent/created', ({ agent }: { agent: any }) => attachPrompt(agent))
  ctx.on('agent/disposed', ({ agent }: { agent: object }) => {
    promptFibers.get(agent)?.dispose().catch(() => {})
    promptFibers.delete(agent)
  })

  // ── 3. 管理工具 ────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'memory_list',
    description: 'List memories for the current workspace and shared global memories, including pending and retired rows.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { count: { type: 'integer', required: true }, lines: { type: 'array', required: true, items: { type: 'string' } } } },
      render: (_args, value) => [{ type: 'text', text: value.count === 0 ? '（暂无长期记忆）' : value.lines.join('\n') }],
    },
    async execute(_args, exec) {
      const workspace = toolWorkspace(exec)
      await ready
      const memories = requireStore().scoped(workspace)
      return {
        count: memories.length,
        lines: memories.map(m => `#${m.id.slice(0, 8)} [${m.kind}] ${m.text}（${m.pinned ? '持久保留' : '普通记忆'}，置信度 ${m.confidence.toFixed(2)}${m.workspace ? `，工作区 ${m.workspace}` : '，全局'}${m.supersededAt ? '，已被取代' : ''}${m.approved === false ? '，⏳待审批' : ''}）`),
      }
    },
    presentCall: () => ({ card: 'generic', title: '列出项目记忆', kind: 'other', rawInput: {} }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_pin',
    description: 'Set or cancel persistent retention for one approved, active memory, only when explicitly requested by the user. Use memory_list to identify the exact record. Persistent memories do not decay with time, but can still be replaced or deleted and remain subject to relevance and prompt limits. This does not approve pending memories.',
    parameters: {
      id: { type: 'string', required: true, description: 'Unique memory id prefix from memory_list.' },
      pinned: { type: 'boolean', required: true, description: 'true to retain without time decay; false to resume decay using the original age.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { updated: { type: 'boolean', required: true }, detail: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.detail }],
    },
    async execute(args, exec) {
      const workspace = toolWorkspace(exec)
      await ready
      const out = await requireStore().pin(args.id, args.pinned, workspace)
      return {
        updated: out !== undefined,
        detail: !out ? '未找到唯一匹配的已批准、未退役记忆' : args.pinned
          ? `已设为持久保留：[${out.kind}] ${out.text}；仍受相关性与上下文容量限制，可更新或删除`
          : `已取消持久保留：[${out.kind}] ${out.text}；按原时间恢复衰减，可能不再自动注入`,
      }
    },
    presentCall: args => ({ card: 'generic', title: args.pinned ? '设置持久记忆' : '取消持久保留', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_approve',
    description: 'Approve one pending memory by id (requireApproval mode). Approved memories become eligible for injection.',
    parameters: {
      id: { type: 'string', required: true, description: 'Memory id prefix from memory_list.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { approved: { type: 'boolean', required: true }, detail: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.detail }],
    },
    async execute(args, exec) {
      const workspace = toolWorkspace(exec)
      await ready
      const out = await requireStore().approve(args.id, workspace)
      return { approved: out !== undefined, detail: out ? `已批准：[${out.kind}] ${out.text}` : '未找到匹配的记忆' }
    },
    presentCall: args => ({ card: 'generic', title: '批准项目记忆', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Delete one long-term memory by id (as shown by memory_list) or by matching keyword.',
    parameters: {
      id: { type: 'string', description: 'Memory id prefix from memory_list. Omit to use keyword.' },
      keyword: { type: 'string', description: 'Delete the single memory whose text contains this keyword.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { deleted: { type: 'boolean', required: true }, detail: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.detail }],
    },
    async execute(args, exec) {
      const workspace = toolWorkspace(exec)
      await ready
      const s = requireStore()
      const removed = await s.forget(args.id, args.keyword, workspace)
      return { deleted: removed !== undefined, detail: removed ? `已删除记忆：[${removed.kind}] ${removed.text}` : '未找到匹配的记忆' }
    },
    presentCall: args => ({ card: 'generic', title: '删除项目记忆', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_extract',
    description: 'Extract durable memories (decisions, conventions, preferences, facts) from the current conversation and store them. Call this when the user states a lasting preference, project rule, or decision worth remembering across sessions.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { saved: { type: 'integer', required: true }, detail: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.detail }],
    },
    async execute(_args, exec) {
      const workspace = toolWorkspace(exec)
      const sessionId: string = exec.agent!.session.id
      await inFlight.get(sessionId)
      const buffer = transcripts.get(sessionId) ?? new TranscriptBuffer()
      // 用户显式要求"记住X"（调用本工具）视为已授权：requireApproval 模式下也直接生效；
      // 只有轮末的自动沉淀才走待审批
      const { newRows, reinforced, error } = await settle('tool', sessionId, buffer, workspace, true)
      const note = error ? `；失败原因：${error}` : ''
      const saved = newRows + reinforced
      const visible = requireStore().scoped(workspace)
      const pending = visible.filter(m => m.approved === false).length
      const pendingNote = pending > 0 ? `；待审批 ${pending} 条（memory_approve 批准）` : ''
      return { saved, detail: `本次新增 ${newRows} 条、强化 ${reinforced} 条（总计 ${visible.length} 条）${pendingNote}${note}` }
    },
    presentCall: () => ({ card: 'generic', title: '沉淀当前会话记忆', kind: 'other', rawInput: {} }),
  }))

  // ── helpers ───────────────────────────────────────────────────────────
  function toolWorkspace(exec: { agent?: { session?: { id?: string; header?: { cwd?: string; origin?: string } } } }): string | undefined {
    const session = exec.agent?.session
    if (!session?.id) throw new Error('memory tools require an owning agent session')
    if (session.header?.origin === 'subagent') throw new Error('memory tools are unavailable to subagents')
    return normalizeWorkspace(session.header?.cwd)
  }

  function bufferFor(sessionId: string): TranscriptBuffer {
    let b = transcripts.get(sessionId)
    if (!b) {
      b = new TranscriptBuffer(24000)
      transcripts.set(sessionId, b)
    }
    return b
  }

  function requireStore(): MemoryStore {
    if (!store) throw new Error('dsh-memory: storage is not ready yet')
    return store
  }

  interface SettleResult { newRows: number; reinforced: number; error?: string }

  /** Track one in-flight extraction per session; advance the cursor only on success. */
  function settle(trigger: string, sessionId: string, buffer: TranscriptBuffer, workspace?: string, forceApproved = false): Promise<SettleResult> {
    const pending = inFlight.get(sessionId)
    if (pending) return pending
    const seen = buffer.seen
    const transcript = buffer.render()
    const work = extractAndStore(trigger, sessionId, transcript, workspace, forceApproved).then(result => {
      if (!result.error) {
        lastSeen.set(sessionId, seen)
        if (buffer.seen === seen) buffer.keepTail(1600)
      }
      return result
    }).finally(() => inFlight.delete(sessionId))
    inFlight.set(sessionId, work)
    return work
  }

  async function extractAndStore(trigger: string, sessionId: string, transcript: string, workspace?: string, forceApproved = false): Promise<SettleResult> {
    try {
      await ready
      if (!transcript.trim()) throw new Error('transcript is empty (no buffered user/assistant text)')
      debugLog(`settle(${trigger}): transcript ${transcript.length} chars`)
      const ws = normalizeWorkspace(workspace)
      const existing: ExistingMemory[] = requireStore().all()
        .filter(m => m.workspace === ws && !m.supersededAt)
        .slice(0, 50)
        .map(m => ({ id: m.id, text: m.text }))
      const extracted = await extractMemories(ctx, config, sessionId, transcript, existing)
      debugLog(`settle(${trigger}): extracted ${JSON.stringify(extracted)}`)
      const store = requireStore()
      // Only accept unambiguous IDs that were offered to this extraction call.
      const resolveIds = (prefixes: string[]) => [...new Set(prefixes.flatMap(prefix => {
        const matches = existing.filter(m => m.id.startsWith(prefix))
        return matches.length === 1 ? [matches[0].id] : []
      }))]
      const supersededIds = resolveIds(extracted.supersede)
      const approved = forceApproved || !config.requireApproval
      // Exclude old facts before dedupe, but retire them only after the new row
      // is persisted and approved. Pending replacements keep the old fact live.
      const newRows = await store.merge(extracted.new, { sessionId, workspace: ws, excludeIds: supersededIds, approved })
      if (approved && extracted.new.length === 0) {
        for (const id of supersededIds) await store.supersede(id, ws)
      }
      let reinforced = 0
      for (const id of resolveIds(extracted.reinforce)) {
        if (!supersededIds.includes(id) && await store.reinforce(id, ws, approved)) reinforced++
      }
      failStreak = 0
      if (newRows + reinforced + supersededIds.length > 0) {
        log.info(`dsh-memory: ${trigger} new ${newRows}, reinforced ${reinforced}, conflict targets ${supersededIds.length}`)
      }
      return { newRows, reinforced }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      debugLog(`settle(${trigger}) FAILED: ${message}`)
      log.warn(`dsh-memory: extraction failed (${trigger}): ${message}`)
      failStreak++
      if (failStreak >= 3) {
        cooldownUntil = Date.now() + 10 * 60_000  // 连续 3 次失败，自动抽取退避 10 分钟
        failStreak = 0
        log.warn('dsh-memory: extraction failed 3x, auto-extraction paused for 10 minutes')
      }
      return { newRows: 0, reinforced: 0, error: message }
    }
  }

  ctx.effect(() => async () => {
    for (const fiber of promptFibers.values()) await fiber.dispose().catch(() => {})
    promptFibers.clear()
    await Promise.allSettled(inFlight.values())
    const domain = await ready
    store = undefined
    await domain.close()
  }, 'dsh-memory: prompt fibers')
  // Subscribe first so agents created during backfill cannot be missed. Await
  // storage and registration before the host reports this plugin as loaded.
  await ready
  await Promise.all(ctx.agents.list().map(attachPrompt))
}

function debugLog(line: string): void {
  const path = process.env.DSH_MEMORY_DEBUG
  if (path) {
    try { appendFileSync(path, `${new Date().toISOString()} ${line}
`) } catch {}
  }
}

/** Normalize a workspace path for use as a scoping key. */
function normalizeWorkspace(cwd?: string): string | undefined {
  if (!cwd) return undefined
  return cwd.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
}

/** Join text blocks out of an LLM message content list. */
function collectText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } => (block as any)?.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}

export type { MemoryRecord }
