// Run against installed plugins and dsh 0.2.0-rc.2, using real Cordis Loader,
// schemas, tool definitions, LLM block assembly and JSON storage. Only the LLM
// transport and app-facing tool/prompt registries are deterministic fixtures.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'

const [profileArg, hostArg, storageArg, legacyVersionArg = '5'] = process.argv.slice(2)
if (!profileArg || !hostArg || !storageArg) throw new Error('Usage: node scripts/verify-host.mjs <profile-dir> <dsh-install-dir> <isolated-storage-dir>')
const profile = resolve(profileArg)
const requireHost = createRequire(join(resolve(hostArg), 'package.json'))
const host = name => import(pathToFileURL(requireHost.resolve(name)).href)
const [{ Context }, { default: Loader }, { default: Storage }, json, domain] = await Promise.all([
  host('@deepseek-ai/cordis'), host('@deepseek-ai/cordis-plugin-loader'),
  host('@deepseek-ai/dsh-storage'), host('@deepseek-ai/dsh-storage-json'), host('@deepseek-ai/dsh-storage-domain'),
])
const workspace = resolve(profile, 'project-a').replace(/\\/g, '/').toLowerCase()
const foreignWorkspace = resolve(profile, 'project-b').replace(/\\/g, '/').toLowerCase()
if (existsSync(join(resolve(storageArg), 'dsh_memory'))) throw new Error('Choose a fresh test storage directory; existing memory data is never overwritten.')

async function boot(replies = []) {
  const ctx = new Context()
  const tools = new Map()
  const sections = []
  const calls = []
  try {
    ctx.provide('tools', { register: tool => { tools.set(tool.name, tool) } })
    ctx.provide('llm', { async *stream(options) {
      calls.push(options)
      assert.ok(replies.length, 'unexpected LLM request')
      yield { type: 'text-delta', index: 0, text: JSON.stringify(replies.shift()) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } })
    ctx.provide('systemPrompt', { section: section => { sections.push(section) } })
    await ctx.plugin(Storage)
    await ctx.plugin(json, { root: resolve(storageArg) })
    await ctx.plugin(domain, { backend: 'json', routes: {} })
    await ctx.plugin(Loader)
    for (const name of ['dsh-memory', 'dsh-commit']) {
      await ctx.loader.create({
        name: pathToFileURL(join(profile, 'node_modules', name, 'dist', 'index.js')).href,
        config: name === 'dsh-memory' ? { requireApproval: true, extractMinChars: 4, autoExtractMinIntervalMs: 0 } : {},
      })
    }
    await ctx.loader.await()
    assert.equal(tools.size, 6, 'five memory tools and one commit tool must load')
    const agent = { ctx, session: { id: crypto.randomUUID(), header: { cwd: workspace, origin: 'user' } } }
    const call = (name, args = {}, owner = agent) => tools.get(name).execute(args, { agent: owner })
    await call('memory_list') // waits for the asynchronous storage open
    return { ctx, agent, call, calls, sections, table: ctx.storageDomain.get('dsh_memory').table('memories') }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

// Seed a prior on-disk schema through the real backend before loading v6.
const legacyVersion = Number(legacyVersionArg)
assert.ok([1, 2, 3, 4, 5].includes(legacyVersion))
const legacyBackend = new json.JsonStorageBackend(resolve(storageArg))
try {
  const unit = await legacyBackend.kv.open({ name: 'dsh_memory', version: legacyVersion, tables: ['memories'], hasGlobal: false, layout: 'per-record' })
  const base = { kind: 'convention', createdAt: new Date().toISOString(), sourceSessionId: 'seed', confidence: 1.3, hits: 0 }
  await unit.putRecord('memories', 'oldfact1', { ...base, id: 'oldfact1', text: '本项目使用 npm 管理依赖', workspace })
  await unit.putRecord('memories', 'foreign1', { ...base, id: 'foreign1', text: '其他工作区的独有事实', workspace: foreignWorkspace, approved: false })
} finally {
  await legacyBackend.close()
}

const first = await boot([{ new: [{ kind: 'convention', text: '本项目使用 pnpm 管理依赖' }], supersede: ['oldfact1'] }])
let pendingId
try {
  assert.equal(first.table.get('oldfact1')?.text, '本项目使用 npm 管理依赖', `schema v${legacyVersion} must remain readable`)
  assert.equal(first.table.get('oldfact1').pinned, undefined, 'legacy rows remain ordinary')
  await first.ctx.parallel('session/event', first.agent.session, {
    type: 'user/message', data: { source: { kind: 'user' }, content: '本项目包管理器已改成 pnpm，请保存该约定' },
  })
  await first.ctx.parallel('agent/turn-stopping', { agent: first.agent })
  const rows = [...first.table.entries()].map(([, r]) => r)
  const pending = rows.find(r => r.text === '本项目使用 pnpm 管理依赖')
  assert.equal(pending?.approved, false)
  assert.equal(first.table.get('oldfact1').supersededAt, undefined)
  pendingId = pending.id
  assert.equal((await first.call('memory_pin', { id: pendingId, pinned: true })).updated, false)
  assert.equal((await first.call('memory_list')).count, 2)
  assert.equal((await first.call('memory_forget', { id: 'foreign1' })).deleted, false)
  await first.ctx.parallel('agent/created', { agent: first.agent })
  await new Promise(resolve => setImmediate(resolve))
  assert.match(first.sections.at(-1).text(), /本项目使用 npm 管理依赖/)
  assert.doesNotMatch(first.sections.at(-1).text(), /pnpm|其他工作区/)
  await first.ctx.parallel('session/disposed', first.agent.session)
  assert.equal(first.calls.length, 1)
} finally {
  await first.ctx.fiber.dispose()
}

const second = await boot()
try {
  assert.equal(second.table.get(pendingId)?.approved, false, 'pending replacement must survive restart')
  assert.equal((await second.call('memory_approve', { id: pendingId })).approved, true)
  assert.ok(second.table.get('oldfact1').supersededAt)
  await second.ctx.parallel('agent/created', { agent: second.agent })
  await new Promise(resolve => setImmediate(resolve))
  const prompt = second.sections.at(-1).text()
  assert.match(prompt, /pnpm/)
  assert.match(prompt, /（来源：#/)
  assert.doesNotMatch(prompt, /本项目使用 npm|其他工作区/)
  assert.equal((await second.call('memory_approve', { id: 'foreign1' })).approved, false)
  await second.table.put(pendingId, { ...second.table.get(pendingId), createdAt: new Date(Date.now() - 365 * 86_400_000).toISOString() })
  assert.equal(second.sections.at(-1).text(), '', 'ordinary old rule fades out')
  assert.equal((await second.call('memory_pin', { id: pendingId, pinned: true })).updated, true)
  assert.match(second.sections.at(-1).text(), /\[持久\].*pnpm/)
} finally {
  await second.ctx.fiber.dispose()
}

const third = await boot()
try {
  assert.equal(third.table.get(pendingId).pinned, true, 'persistent flag must survive JSON serialization and restart')
  await third.ctx.parallel('agent/created', { agent: third.agent })
  await new Promise(resolve => setImmediate(resolve))
  assert.match(third.sections.at(-1).text(), /\[持久\].*pnpm/)
  assert.equal((await third.call('memory_pin', { id: pendingId, pinned: false })).updated, true)
  assert.equal(third.sections.at(-1).text(), '', 'unpin resumes original age')
  assert.equal((await third.call('memory_pin', { id: pendingId, pinned: true })).updated, true)
  assert.equal((await third.call('memory_forget', { id: pendingId })).deleted, true)
  assert.ok(third.table.get('oldfact1').supersededAt, 'retirement must survive restart')
  assert.equal(third.table.get('foreign1').approved, false, 'other workspace must remain untouched')
} finally {
  await third.ctx.fiber.dispose()
}
const fourth = await boot()
try {
  assert.equal(fourth.table.get(pendingId), undefined, 'deletion of a persistent row must survive restart')
} finally {
  await fourth.ctx.fiber.dispose()
}
console.log(`HOST PASS: 6 tools, schema v${legacyVersion} compatibility, JSON persistence across 4 boots, pin/unpin at age 365 days, scoped access, deferred approval, provenance, deletion, no duplicate disposal extraction; no network/model API used.`)
