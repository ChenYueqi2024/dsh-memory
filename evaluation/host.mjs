import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Real host modules; the answer model does not receive these registration APIs. */
export async function loadHost(hostDirectory) {
  const requireHost = createRequire(join(resolve(hostDirectory), 'package.json'))
  const load = name => import(pathToFileURL(requireHost.resolve(name)).href)
  const [{ Context }, { default: Loader }, { default: Storage }, json, domain] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/cordis-plugin-loader'), load('@deepseek-ai/dsh-storage'),
    load('@deepseek-ai/dsh-storage-json'), load('@deepseek-ai/dsh-storage-domain'),
  ])
  return { Context, Loader, Storage, json, domain,
    version: requireHost('@deepseek-ai/dsh/package.json').version }
}

export async function bootMemory(host, { pluginPath, storage, workspaceRoot, requireApproval, transport, label }) {
  const ctx = new host.Context(), tools = new Map(), sections = []
  const workspace = key => resolve(workspaceRoot, key).replace(/\\/g, '/').toLowerCase()
  const agent = key => ({ ctx, session: { id: crypto.randomUUID(), header: { cwd: workspace(key), origin: 'user' } } })
  try {
    ctx.provide('tools', { register: tool => tools.set(tool.name, tool) })
    ctx.provide('systemPrompt', { section: section => sections.push(section) })
    ctx.provide('llm', { async *stream(options) {
      const messages = [{ role: 'system', content: options.system }, ...options.messages.map(message => ({
        role: message.role, content: typeof message.content === 'string' ? message.content : message.content.filter(b => b.type === 'text').map(b => b.text).join('\n'),
      }))]
      const response = await transport.complete({ messages, phase: 'extraction', maxTokens: options.maxTokens, signal: options.signal }, label)
      yield { type: 'text-delta', index: 0, text: response.text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } })
    await ctx.plugin(host.Storage)
    await ctx.plugin(host.json, { root: storage })
    await ctx.plugin(host.domain, { backend: 'json', routes: {} })
    await ctx.plugin(host.Loader)
    await ctx.loader.create({ name: pathToFileURL(pluginPath).href,
      config: { requireApproval, extractMinChars: 1, autoExtractMinIntervalMs: 0, injectMax: 30, maxOutputTokens: 1024, timeoutMs: 120000 } })
    await ctx.loader.await()
    for (const name of ['memory_list', 'memory_forget', 'memory_extract', 'memory_approve']) {
      if (!tools.has(name)) throw new Error(`Memory plugin did not load required tool: ${name}`)
    }
    await tools.get('memory_list').execute({}, { agent: agent('a') })
    const records = () => [...ctx.storageDomain.get('dsh_memory').table('memories').entries()].map(([, value]) => value)
    return {
      records,
      async replay(session) {
        const owner = agent(session.workspace)
        await ctx.parallel('session/event', owner.session, { type: 'user/message', data: { source: { kind: 'user' }, content: session.text } })
        await ctx.parallel('session/event', owner.session, { type: 'assistant/message', data: { message: { content: '已收到本次项目说明。' } } })
        if (session.trigger === 'explicit') await tools.get('memory_extract').execute({}, { agent: owner })
        else await ctx.parallel('agent/turn-stopping', { agent: owner })
        // No disposed fallback: exactly one extraction per scripted history session.
        if (transport.fatal) throw new Error('Extraction transport failed; remaining cells will not run')
      },
      async action(action) {
        const matches = records().filter(r => r.workspace === workspace(action.workspace) && !r.supersededAt
          && (action.tool !== 'memory_approve' || r.approved === false) && r.text.includes(action.match))
        if (matches.length !== 1) throw new Error(`Action target count ${matches.length}; expected exactly one`)
        const result = await tools.get(action.tool).execute({ id: matches[0].id }, { agent: agent(action.workspace) })
        if (!(result.approved ?? result.deleted)) throw new Error('Governance action was not applied')
        return { tool: action.tool, id: matches[0].id, result }
      },
      async context(query) {
        const owner = agent(query.workspace)
        // Retrieval receives the question, but no answer or rubric and no training turn.
        await ctx.parallel('session/event', owner.session, { type: 'user/message', data: { source: { kind: 'user' }, content: query.text } })
        await ctx.parallel('agent/created', { agent: owner })
        await new Promise(resolve => setImmediate(resolve))
        if (sections.length !== 1) throw new Error('Expected exactly one memory prompt section')
        const text = sections[0].text()
        await ctx.parallel('agent/disposed', { agent: owner })
        return text
      },
      close: () => ctx.fiber.dispose(),
    }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}
