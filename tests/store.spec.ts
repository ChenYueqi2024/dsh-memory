import { describe, expect, it } from 'vitest'
import { MemoryStore, tokenize, type MemoryRecord } from '../src/store.ts'

/** Map-backed KvTable stub: put/delete are async like the real domain API. */
function fakeTable(records: MemoryRecord[] = []) {
  const map = new Map<string, MemoryRecord>(records.map(r => [r.id, r]))
  return {
    get: (key: string) => map.get(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    get size() { return map.size },
    put: async (key: string, value: MemoryRecord) => { map.set(key, value) },
    delete: async (key: string) => map.delete(key),
    update: async (key: string, fn: (c: MemoryRecord) => MemoryRecord) => {
      const next = fn(map.get(key)!)
      map.set(key, next)
      return next
    },
  }
}

const base = { sourceSessionId: 's1', confidence: 1, hits: 0 }

function record(partial: Partial<MemoryRecord>): MemoryRecord {
  return { id: partial.id ?? crypto.randomUUID(), kind: 'fact', text: '', createdAt: new Date().toISOString(), ...base, ...partial } as MemoryRecord
}

describe('MemoryStore.merge', () => {
  it('adds new records and stamps the workspace', async () => {
    const store = new MemoryStore(fakeTable() as never)
    const added = await store.merge([{ kind: 'fact', text: '本项目部署在 D 盘' }], { sessionId: 's1', workspace: 'd:/dev/proj' })
    expect(added).toBe(1)
    expect(store.all()[0].workspace).toBe('d:/dev/proj')
  })

  it('dedupes exact matches regardless of punctuation and case', async () => {
    const store = new MemoryStore(fakeTable() as never)
    await store.merge([{ kind: 'fact', text: '所有回答必须使用中文' }], { sessionId: 's1' })
    const added = await store.merge([{ kind: 'fact', text: '所有回答必须使用中文。' }], { sessionId: 's2' })
    expect(added).toBe(0)
    expect(store.all()).toHaveLength(1)
    expect(store.all()[0].confidence).toBeGreaterThan(1)
  })

  it('dedupes rephrased duplicates via token Jaccard', async () => {
    const store = new MemoryStore(fakeTable() as never)
    await store.merge([{ kind: 'preference', text: '用户要求所有回答必须使用中文' }], { sessionId: 's1' })
    const added = await store.merge([{ kind: 'preference', text: '用户要求在本项目中所有回答都要使用中文' }], { sessionId: 's2' })
    expect(added).toBe(0)
    expect(store.all()).toHaveLength(1)
  })

  it('keeps the same fact in different workspaces separate', async () => {
    const store = new MemoryStore(fakeTable() as never)
    await store.merge([{ kind: 'fact', text: '发布节奏是每两周一个版本' }], { sessionId: 's1', workspace: 'd:/a' })
    const added = await store.merge([{ kind: 'fact', text: '发布节奏是每两周一个版本' }], { sessionId: 's2', workspace: 'd:/b' })
    expect(added).toBe(1)
    expect(store.all()).toHaveLength(2)
  })
})

describe('MemoryStore.effective / rankForInjection', () => {
  it('decays confidence with per-kind half-lives (fact=14d, preference=45d)', () => {
    const store = new MemoryStore(fakeTable() as never)
    const freshFact = record({ kind: 'fact', createdAt: new Date().toISOString(), confidence: 1 })
    const fact14d = record({ kind: 'fact', createdAt: new Date(Date.now() - 14 * 86_400_000).toISOString(), confidence: 1 })
    const pref14d = record({ kind: 'preference', createdAt: new Date(Date.now() - 14 * 86_400_000).toISOString(), confidence: 1 })
    expect(store.effective(freshFact)).toBeCloseTo(1, 5)
    expect(store.effective(fact14d)).toBeCloseTo(0.5, 5)
    // 同样 14 天：偏好几乎没衰减，事实已减半 —— 事实保鲜期短、偏好更持久
    expect(store.effective(pref14d)).toBeGreaterThan(0.75)
  })

  it('never injects memories decayed below the floor', async () => {
    const ancient = record({ text: '很旧的记忆条目内容', createdAt: new Date(Date.now() - 400 * 86_400_000).toISOString(), confidence: 1 })
    const store = new MemoryStore(fakeTable([ancient]) as never)
    expect(store.rankForInjection(10)).toEqual([])
  })

  it('ranks keyword-matching memories above stronger but irrelevant ones', async () => {
    const table = fakeTable([
      record({ id: 'b-strong', text: '团队规定合并需要两人签字', confidence: 2, createdAt: new Date().toISOString() }),
      record({ id: 'a-relevant', text: 'Python 代码统一用 ruff 做 lint', confidence: 1, createdAt: new Date().toISOString() }),
    ]) as never
    const store = new MemoryStore(table)
    const top = store.rankForInjection(2, '我们项目的 python lint 工具是什么？')
    expect(top[0].id).toBe('a-relevant')
  })

  it('scopes injection to the current workspace plus globals', async () => {
    const table = fakeTable([
      record({ id: 'proj-a', text: 'A 项目的独有约定条目', workspace: 'd:/a' }),
      record({ id: 'global', text: '全局通用的偏好设定条目' }),
    ]) as never
    const store = new MemoryStore(table)
    const seen = store.rankForInjection(10, undefined, 'd:/a').map(m => m.id)
    expect(seen).toContain('proj-a')
    expect(seen).toContain('global')
    expect(store.rankForInjection(10, undefined, 'd:/b').map(m => m.id)).toEqual(['global'])
  })
})

describe('MemoryStore.markHit', () => {
  it('counts one hit per debounce window and reinforces confidence', async () => {
    const rec = record({ id: 'hit-me-1', text: '常被命中的记忆条目', confidence: 1 })
    const table = fakeTable([rec]) as never
    const store = new MemoryStore(table)
    for (let i = 0; i < 5; i++) store.markHit('hit-me-1')
    await new Promise(r => setTimeout(r, 20))
    expect(store.all()[0].confidence).toBeCloseTo(1.02, 5)
    expect(store.all()[0].hits).toBe(1)
    // 超过去抖窗口后再次命中应重新计数
    const hit = store.all()[0]
    await table.put('hit-me-1', { ...hit, lastHitAt: new Date(Date.now() - 61_000).toISOString() })
    store.markHit('hit-me-1')
    await new Promise(r => setTimeout(r, 20))
    expect(store.all()[0].hits).toBe(2)
  })
})

describe('MemoryStore.reinforce', () => {
  it('bumps confidence of an existing record by id prefix', async () => {
    const rec = record({ id: 'abcd1234-z', text: '已有记忆条目内容', confidence: 1 })
    const store = new MemoryStore(fakeTable([rec]) as never)
    const out = await store.reinforce('abcd')
    expect(out?.confidence).toBeCloseTo(1.15, 5)
    expect(store.all()).toHaveLength(1)
    expect(await store.reinforce('zzzz')).toBeUndefined()
  })
})

describe('MemoryStore.supersede and budget', () => {
  it('excludes superseded records from injection but keeps them stored', async () => {
    const old = record({ id: 'old-one-1', text: '部署窗口是周三凌晨' })
    const store = new MemoryStore(fakeTable([old]) as never)
    const out = await store.supersede('old-one')
    expect(out?.supersededAt).toBeDefined()
    expect(store.rankForInjection(10)).toEqual([])
    expect(store.all()).toHaveLength(1)
    expect(await store.supersede('old-one')).toBeDefined()
  })

  it('caps total injected text by the character budget', () => {
    const records = Array.from({ length: 8 }, (_, i) =>
      record({ id: `bud-${i}`, text: `记忆条目第${i}条的内容比较长用来测试预算截断逻辑`, createdAt: new Date(Date.now() - i * 1000).toISOString() }))
    const store = new MemoryStore(fakeTable(records) as never)
    const out = store.rankForInjection(10, undefined, undefined, 200)
    expect(out.length).toBeGreaterThan(1)
    expect(out.reduce((n, r) => n + r.text.length, 0)).toBeLessThanOrEqual(200 + 24 * out.length)
  })
})

describe('MemoryStore.forget', () => {
  it('deletes by id prefix and by unique keyword, not by ambiguous keyword', async () => {
    const table = fakeTable([
      record({ id: 'abcd1234-x', text: '记忆条目甲' }),
      record({ id: 'efgh5678-y', text: '记忆条目乙' }),
    ]) as never
    const store = new MemoryStore(table)
    expect((await store.forget('abcd'))?.id).toBe('abcd1234-x')
    expect((await store.forget(undefined, '条目乙'))?.id).toBe('efgh5678-y')
    expect(await store.forget(undefined, '条目')).toBeUndefined()
    expect(store.all()).toHaveLength(0)
  })
})

describe('tokenize', () => {
  it('produces latin words and CJK bigrams', () => {
    const terms = tokenize('用 ruff 做 lint 格式化')
    expect(terms.has('ruff')).toBe(true)
    expect(terms.has('lint')).toBe(true)
    expect(terms.has('格式')).toBe(true)
    expect(terms.has('式化')).toBe(true)
  })
})
