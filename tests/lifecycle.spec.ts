import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/index.ts'
import type { MemoryRecord } from '../src/store.ts'

const config: Config = {
  provider: 'test', model: 'test', maxOutputTokens: 1024, timeoutMs: 1000,
  extractMinChars: 4, autoExtractMinIntervalMs: 0, injectMax: 30, requireApproval: false,
}
const row = (id: string, workspace?: string, extra = {}): MemoryRecord => ({
  id, workspace, kind: 'fact', text: `记忆内容 ${id}`, createdAt: new Date().toISOString(),
  sourceSessionId: 'seed', confidence: 1, hits: 0, ...extra,
})

async function harness(records: MemoryRecord[] = [], overrides: Partial<Config> = {}, existing: { cwd?: string; origin?: string }[] = []) {
  const rows = new Map(records.map(r => [r.id, r]))
  const events = new Map<string, (...args: any[]) => any>()
  const tools = new Map<string, any>()
  const replies: (object | Error)[] = []
  const requests: any[] = []
  const effects: (() => Promise<void>)[] = []
  const closeDomain = vi.fn(async () => {})
  const existingAgents = existing.map((a, i) => agent(`existing-${i}`, a.cwd, a.origin))
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on: (name: string, listener: (...args: any[]) => any) => events.set(name, listener),
    effect(setup: () => () => Promise<void>) { effects.push(setup()) },
    agents: { list: () => existingAgents },
    tools: { register: (tool: any) => tools.set(tool.name, tool) },
    storageDomain: { open: async () => ({ close: closeDomain, table: () => ({
      entries: () => rows.entries(), get: (id: string) => rows.get(id),
      put: async (id: string, value: MemoryRecord) => { rows.set(id, value) },
      delete: async (id: string) => rows.delete(id),
    }) }) },
    llm: { async *stream(request: any) {
      requests.push(request)
      const reply = replies.shift() ?? { new: [] }
      if (reply instanceof Error) throw reply
      yield { type: 'text-delta', index: 0, text: JSON.stringify(reply) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
  }
  await apply(ctx as never, { ...config, ...overrides })
  await Promise.resolve()
  function agent(id = 's1', cwd = 'D:\\A\\', origin = 'user') {
    const sections: any[] = []
    const dispose = vi.fn(async () => {})
    return { session: { id, header: { cwd, origin } }, sections, dispose,
      ctx: { inject: (_deps: unknown, fn: (scope: any) => void) => {
        fn({ systemPrompt: { section: (section: any) => sections.push(section) } })
        return { dispose }
      } },
    }
  }
  const emit = async (event: string, ...args: any[]) => {
    await events.get(event)?.(...args)
    // session/disposed is an observer in the host, not an awaited shutdown hook.
    await new Promise(resolve => setImmediate(resolve))
  }
  const say = (a: ReturnType<typeof agent>, text = '本项目使用 pnpm 管理依赖') =>
    emit('session/event', a.session, { type: 'user/message', data: { content: text, source: { kind: 'user' } } })
  const call = (name: string, a: ReturnType<typeof agent> | undefined, args = {}) => tools.get(name).execute(args, { agent: a })
  return { rows, replies, requests, agent, emit, say, call, existingAgents, closeDomain,
    unload: async () => { for (const dispose of effects) await dispose() } }
}

afterEach(() => vi.restoreAllMocks())

describe('plugin lifecycle and tool boundaries', () => {
  it('backfills an empty agent created before hot installation with scoped memory', async () => {
    const h = await harness([row('local001', 'd:/a'), row('other001', 'd:/b'), row('global01'),
      row('pending1', 'd:/a', { approved: false }), row('retired1', 'd:/a', { supersededAt: new Date().toISOString() })], {}, [{}])
    const a = h.existingAgents[0]
    expect(a.sections).toHaveLength(1)
    const text = a.sections[0].text()
    expect(text).toContain('local001')
    expect(text).toContain('global01')
    expect(text).not.toMatch(/other001|pending1|retired1/)
    expect(h.requests).toHaveLength(0)
  })

  it('does not register duplicate sections when backfill and created target the same agent', async () => {
    const h = await harness([row('local001', 'd:/a')], {}, [{}])
    const a = h.existingAgents[0]
    await h.emit('agent/created', { agent: a })
    await h.emit('agent/created', { agent: a })
    expect(a.sections).toHaveLength(1)
  })

  it('excludes pre-existing subagents from hot-install backfill', async () => {
    const h = await harness([row('local001', 'd:/a')], {}, [{ origin: 'subagent' }])
    expect(h.existingAgents[0].sections).toHaveLength(0)
  })

  it('cleans up backfilled sections on agent disposal and plugin unload', async () => {
    const h = await harness([], {}, [{}, {}])
    await h.emit('agent/disposed', { agent: h.existingAgents[0] })
    await h.unload()
    for (const a of h.existingAgents) expect(a.dispose).toHaveBeenCalledOnce()
    expect(h.closeDomain).toHaveBeenCalledOnce()
  })

  it('lists and mutates only the current workspace and globals', async () => {
    const h = await harness([row('aaaa1111', 'd:/a'), row('bbbb2222', 'd:/b', { approved: false }), row('glob3333')])
    const a = h.agent()
    const list = await h.call('memory_list', a)
    expect(list.count).toBe(2)
    expect(list.lines.join('\n')).not.toContain('bbbb2222')
    expect((await h.call('memory_approve', a, { id: 'bbbb2222' })).approved).toBe(false)
    expect((await h.call('memory_forget', a, { keyword: 'bbbb2222' })).deleted).toBe(false)
    expect((await h.call('memory_forget', a, { id: 'bbbb2222' })).deleted).toBe(false)
    expect(h.rows.get('bbbb2222')?.approved).toBe(false)
    expect((await h.call('memory_forget', a, { id: 'glob3333' })).deleted).toBe(true)
  })

  it('rejects tools without an owning session and from subagents', async () => {
    const h = await harness()
    for (const a of [undefined, h.agent('sub', 'D:\\A', 'subagent')]) {
      for (const name of ['memory_list', 'memory_approve', 'memory_forget', 'memory_extract', 'memory_pin']) {
        await expect(h.call(name, a, { id: 'aaaa' })).rejects.toThrow(/session|subagent/)
      }
    }
  })

  it('pins a selected approved row without model calls and reports unpinning consequences', async () => {
    const old = new Date(Date.now() - 365 * 86_400_000).toISOString()
    const h = await harness([row('aaaa1111', 'd:/a', { createdAt: old }), row('bbbb2222', 'd:/b')])
    const a = h.agent()
    expect((await h.call('memory_pin', a, { id: 'aaaa', pinned: true })).updated).toBe(true)
    expect((await h.call('memory_list', a)).lines[0]).toContain('持久保留')
    const next = h.agent('s2')
    await h.emit('agent/created', { agent: next })
    expect(next.sections[0].text()).toContain('[持久]')
    expect((await h.call('memory_pin', a, { id: 'bbbb', pinned: true })).updated).toBe(false)
    const unpin = await h.call('memory_pin', a, { id: 'aaaa', pinned: false })
    expect(unpin.updated).toBe(true)
    expect(unpin.detail).toContain('原时间')
    expect(unpin.detail).toContain('可能不再自动注入')
    expect(next.sections[0].text()).toBe('')
    expect(h.requests).toHaveLength(0)
  })

  it('does not let extraction nominate persistent memories', async () => {
    const h = await harness()
    const a = h.agent()
    h.replies.push({ new: [{ kind: 'convention', text: '本项目使用 pnpm 管理依赖', pinned: true }] })
    await h.say(a)
    await h.emit('agent/turn-stopping', { agent: a })
    expect([...h.rows.values()][0].pinned).not.toBe(true)
  })

  it('persists automatic extraction in its workspace and injects with provenance', async () => {
    const h = await harness()
    const a = h.agent()
    h.replies.push({ new: [{ kind: 'convention', text: '本项目使用 pnpm 管理依赖' }] })
    await h.say(a)
    await h.emit('agent/turn-stopping', { agent: a })
    expect([...h.rows.values()][0]).toMatchObject({ workspace: 'd:/a', approved: true })
    const next = h.agent('s2')
    await h.emit('agent/created', { agent: next })
    expect(next.sections[0].text()).toContain('（来源：#')
    const other = h.agent('s3', 'D:\\B')
    await h.emit('agent/created', { agent: other })
    expect(other.sections[0].text()).toBe('')
    await h.emit('agent/disposed', { agent: next })
    expect(next.dispose).toHaveBeenCalledOnce()
  })

  it('does not extract the same tail again on disposal', async () => {
    const h = await harness()
    const a = h.agent()
    await h.say(a)
    await h.emit('agent/turn-stopping', { agent: a })
    await h.emit('session/disposed', a.session)
    expect(h.requests).toHaveLength(1)
  })

  it('disposal extracts unprocessed text with workspace scope', async () => {
    const h = await harness()
    const a = h.agent()
    h.replies.push({ new: [{ kind: 'fact', text: '本项目部署在 D 盘' }] })
    await h.say(a)
    await h.emit('session/disposed', a.session)
    expect([...h.rows.values()][0]?.workspace).toBe('d:/a')
  })

  it('retries failed extraction without requiring more conversation', async () => {
    const h = await harness()
    const a = h.agent()
    h.replies.push(new Error('offline'), { new: [{ kind: 'fact', text: '本项目部署在 D 盘' }] })
    await h.say(a)
    await h.emit('agent/turn-stopping', { agent: a })
    await h.emit('agent/turn-stopping', { agent: a })
    expect(h.requests).toHaveLength(2)
    expect(h.rows.size).toBe(1)
  })

  it('throttles each session separately and accumulates its skipped increment', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const h = await harness([], { autoExtractMinIntervalMs: 90_000 })
    const a = h.agent(), b = h.agent('s2', 'D:\\B')
    await h.say(a)
    await h.emit('agent/turn-stopping', { agent: a })
    await h.say(b)
    await h.emit('agent/turn-stopping', { agent: b })
    expect(h.requests).toHaveLength(2)
    await h.say(a, '新增约定：测试使用 vitest')
    await h.emit('agent/turn-stopping', { agent: a })
    expect(h.requests).toHaveLength(2)
    now.mockReturnValue(190_001)
    await h.emit('agent/turn-stopping', { agent: a })
    expect(h.requests).toHaveLength(3)
    expect(h.requests[2].messages[0].content[0].text).toContain('新增约定')
  })

  it('coalesces overlapping automatic hooks for the same transcript', async () => {
    const h = await harness()
    const a = h.agent()
    await h.say(a)
    await Promise.all([h.emit('agent/turn-stopping', { agent: a }), h.emit('session/disposed', a.session)])
    expect(h.requests).toHaveLength(1)
  })

  it.each(['new', 'reinforce'])('explicit extraction approves an existing pending row through %s', async field => {
    const h = await harness([row('pending1', 'd:/a', { text: '本项目使用 pnpm 管理依赖', approved: false })], { requireApproval: true })
    const a = h.agent()
    h.replies.push(field === 'new'
      ? { new: [{ kind: 'convention', text: '本项目使用 pnpm 管理依赖' }] }
      : { reinforce: ['pending1'] })
    await h.say(a)
    await h.call('memory_extract', a)
    expect(h.rows.get('pending1')?.approved).toBe(true)
  })

  it('holds conflict retirement until the replacement is approved', async () => {
    const h = await harness([row('oldfact1', 'd:/a', { text: '发布窗口固定在周三凌晨' })], { requireApproval: true })
    const a = h.agent()
    h.replies.push({ new: [{ kind: 'fact', text: '发布窗口改为周五凌晨' }], supersede: ['oldfact1'] })
    await h.say(a)
    await h.emit('agent/turn-stopping', { agent: a })
    expect(h.rows.get('oldfact1')?.supersededAt).toBeUndefined()
    const pending = [...h.rows.values()].find(r => r.id !== 'oldfact1')!
    expect(pending.approved).toBe(false)
    await h.call('memory_approve', a, { id: pending.id })
    expect(h.rows.get('oldfact1')?.supersededAt).toBeDefined()
    expect(h.rows.get(pending.id)?.approved).toBe(true)
  })

  it('ignores model IDs outside the active extraction scope', async () => {
    const h = await harness([row('outside1', 'd:/b'), row('global01'), row('retired1', 'd:/a', { supersededAt: new Date().toISOString() })])
    const a = h.agent()
    const before = JSON.stringify([...h.rows.values()])
    h.replies.push({ supersede: ['outside1', 'global01'], reinforce: ['outside1', 'retired1'] })
    await h.say(a)
    await h.emit('agent/turn-stopping', { agent: a })
    expect(JSON.stringify([...h.rows.values()])).toBe(before)
    expect(h.requests[0].messages[0].content[0].text).not.toContain('retired1')
  })

  it.each([false, true])('requires the whole replacement batch before retiring old facts (delete sibling: %s)', async deleteSibling => {
    const h = await harness([row('oldfact1', 'd:/a', { text: '本项目使用 npm 管理依赖' })], { requireApproval: true })
    const a = h.agent()
    h.replies.push({ new: [
      { kind: 'convention', text: '包管理器改为 pnpm' },
      { kind: 'decision', text: '数据库选择 PostgreSQL' },
    ], supersede: ['oldfact1'] })
    await h.say(a)
    await h.emit('agent/turn-stopping', { agent: a })
    const candidates = [...h.rows.values()].filter(r => r.approved === false)
    expect(candidates).toHaveLength(2)
    if (deleteSibling) await h.call('memory_forget', a, { id: candidates[0].id })
    await h.call('memory_approve', a, { id: candidates[1].id })
    expect(h.rows.get('oldfact1')?.supersededAt).toBeUndefined()
    if (!deleteSibling) {
      await h.call('memory_approve', a, { id: candidates[0].id })
      expect(h.rows.get('oldfact1')?.supersededAt).toBeDefined()
    }
  })

  it('ignores automatic events and prompt injection for subagents', async () => {
    const h = await harness()
    const sub = h.agent('sub', 'D:\\A', 'subagent')
    await h.say(sub)
    await h.emit('agent/turn-stopping', { agent: sub })
    await h.emit('session/disposed', sub.session)
    await h.emit('agent/created', { agent: sub })
    expect(h.requests).toHaveLength(0)
    expect(sub.sections).toHaveLength(0)
  })
})
