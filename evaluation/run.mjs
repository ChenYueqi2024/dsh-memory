import { readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { performance } from 'node:perf_hooks'
import { execFileSync } from 'node:child_process'
import { validate, plan, hash, score, answerMessages, summarize, markdown, redact } from './core.mjs'
import { createTransport, ENDPOINT } from './transport.mjs'
import { loadHost, bootMemory } from './host.mjs'

const directory = dirname(fileURLToPath(import.meta.url)), repo = dirname(directory)
const { values } = parseArgs({ options: {
  mode: { type: 'string', default: 'plan' }, repeats: { type: 'string', default: '3' }, seed: { type: 'string', default: '20261114' },
  case: { type: 'string' }, out: { type: 'string' }, model: { type: 'string', default: 'deepseek-flash' },
  host: { type: 'string', default: dirname(repo) }, 'max-calls': { type: 'string' },
} })

async function main() {
  if (!['plan', 'smoke', 'live'].includes(values.mode)) throw new Error('Use --mode plan, smoke or live')
  if (!/^[a-z0-9._-]{1,100}$/i.test(values.model)) throw new Error('Invalid model name')
  const casesText = readFileSync(join(directory, 'cases.json'), 'utf8'), rubricText = readFileSync(join(directory, 'rubric.json'), 'utf8')
  const dataset = JSON.parse(casesText), rubric = JSON.parse(rubricText).cases
  validate(dataset.cases, rubric)
  const selected = values.case?.split(',')
  if (selected?.some(id => !dataset.cases.some(c => c.id === id))) throw new Error('Unknown case ID')
  const cases = selected ? dataset.cases.filter(c => selected.includes(c.id)) : dataset.cases
  const schedule = plan(cases, Number(values.repeats), Number(values.seed))
  const budget = values['max-calls'] === undefined ? schedule.maxCalls : Number(values['max-calls'])
  if (!Number.isSafeInteger(budget) || budget < schedule.maxCalls) throw new Error(`--max-calls must cover the plan (${schedule.maxCalls}); select fewer cases/repeats to reduce it`)
  if (values.mode === 'plan') {
    console.log(JSON.stringify({ ...schedule, cells: undefined, protocol: dataset.version, groups: ['none', 'static', 'memory'],
      comparisonCases: cases.filter(c => c.suite === 'comparison').length, diagnosticCases: cases.filter(c => c.suite === 'diagnostic').length,
      note: 'No API calls; maxOutputTokens is a configured ceiling, not measured usage or price.' }, null, 2))
    return
  }
  const key = values.mode === 'live' ? process.env.DEEPSEEK_API_KEY : undefined
  if (values.mode === 'live' && !key) throw new Error('Set DEEPSEEK_API_KEY in this terminal before --mode live; no files or requests created')
  // Never let a caller's debug setting redirect benchmark transcripts to a daily log.
  delete process.env.DSH_MEMORY_DEBUG
  const pluginPath = join(repo, 'dist', 'index.js')
  const sources = ['package.json', 'package-lock.json', 'build.mjs', ...readdirSync(join(repo, 'src')).filter(f => f.endsWith('.ts')).map(f => `src/${f}`)]
  if (sources.some(f => f !== 'package.json' && f !== 'package-lock.json' && statSync(join(repo, f)).mtimeMs > statSync(pluginPath).mtimeMs)) {
    throw new Error('Build is older than source; run npm run build first')
  }
  const host = await loadHost(values.host)
  const secrets = [process.env.DEEPSEEK_API_KEY, process.env.GH_TOKEN, process.env.GITHUB_TOKEN]
  const safe = value => redact(JSON.stringify(value, null, 2), secrets)
  const output = resolve(values.out ?? join(directory, 'runs', `${values.mode}-${Date.now()}`))
  mkdirSync(dirname(output), { recursive: true })
  mkdirSync(output) // exclusive: never reuse or erase an earlier run
  const save = (name, value) => writeFileSync(join(output, name), safe(value) + '\n')
  let gitHead = null
  try { gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim() } catch {}
  const manifest = { mode: values.mode, startedAt: new Date().toISOString(), datasetVersion: dataset.version,
    caseHash: hash(casesText), rubricHash: hash(rubricText), sourceHashes: Object.fromEntries(sources.map(f => [f, hash(readFileSync(join(repo, f)))])),
    evaluatorHashes: Object.fromEntries(readdirSync(directory).filter(f => f.endsWith('.mjs')).map(f => [f, hash(readFileSync(join(directory, f)))])),
    bundleHash: hash(readFileSync(pluginPath)), gitHead, node: process.version, platform: process.platform, hostVersion: host.version,
    model: values.model, endpoint: ENDPOINT, temperature: 0, thinking: 'disabled', responseFormat: 'json_object', maxCalls: budget,
    pluginConfig: { requireApproval: 'per case', extractMinChars: 1, autoExtractMinIntervalMs: 0, injectMax: 30, maxOutputTokens: 1024 },
    historyReplay: 'Scripted user text and identical acknowledgement; separate fresh query context, no tools at answer time.', schedule }
  save('manifest.json', manifest)
  const transport = createTransport({ mode: values.mode, model: values.model, key, maxCalls: budget,
    onRecord: record => appendFileSync(join(output, 'calls.jsonl'), redact(JSON.stringify(record), secrets) + '\n') })
  const results = []
  for (const cell of schedule.cells) {
    const c = cases.find(c => c.id === cell.caseId), start = performance.now()
    const row = { ...cell, status: 'pending', context: '', response: null, records: null, actions: [], score: null }
    if (transport.fatal) row.status = 'skipped'
    else {
      try {
        const cellRoot = join(output, 'cells', `${c.id}-${cell.repeat}-${cell.group}`)
        const workspaceRoot = join(cellRoot, 'workspaces')
        const scopes = new Set([...c.sessions.map(s => s.workspace), c.query.workspace])
        for (const scope of scopes) {
          mkdirSync(join(workspaceRoot, scope), { recursive: true })
          if (cell.group === 'static') writeFileSync(join(workspaceRoot, scope, 'AGENTS.md'), c.agents[scope] ?? '')
        }
        const historyStart = performance.now()
        if (cell.group === 'memory') {
          const options = { pluginPath, storage: join(cellRoot, 'storage'), workspaceRoot, requireApproval: c.requireApproval ?? false, transport, label: cell }
          const learning = await bootMemory(host, options)
          try {
            for (const session of c.sessions) await learning.replay(session)
            for (const action of c.actions ?? []) row.actions.push(await learning.action(action))
          } finally { await learning.close() }
          row.historyMs = performance.now() - historyStart
          const fresh = await bootMemory(host, options)
          try {
            row.context = await fresh.context(c.query)
            row.records = fresh.records()
          } finally { await fresh.close() }
        } else {
          row.historyMs = 0 // common scripted history has no model calls in either baseline
          if (cell.group === 'static') {
            const text = readFileSync(join(workspaceRoot, c.query.workspace, 'AGENTS.md'), 'utf8')
            row.context = text ? `## 当前项目 AGENTS.md\n${text}` : ''
          }
        }
        row.contextChars = row.context.length
        row.question = c.query.text
        const response = await transport.complete({ phase: 'answer', messages: answerMessages(row.context, c.query.text), maxTokens: 256 }, cell)
        row.response = response.text
        row.status = 'ok'
      } catch (error) {
        row.status = 'error'
        row.error = redact(error.message, secrets)
      }
    }
    row.elapsedMs = Math.round((performance.now() - start) * 100) / 100
    const refs = cell.group === 'static' && row.context ? ['AGENTS.md'] : [...row.context.matchAll(/来源：(#[-a-z0-9]+)/g)].map(m => m[1])
    row.score = values.mode === 'smoke' ? null : score(row.response ?? '', rubric[c.id], refs, row.records)
    results.push(row)
    save('results.json', results)
    console.log(`${results.length}/${schedule.cellCount} ${c.id} ${cell.group} ${row.status}`)
  }
  const summary = summarize(results, transport.calls, values.mode, schedule)
  save('summary.json', summary)
  writeFileSync(join(output, 'REPORT.md'), markdown(summary))
  const csv = ['case,repeat,suite,group,status,correct,format_valid,source_valid,context_chars,elapsed_ms', ...results.map(r =>
    [r.caseId, r.repeat, r.suite, r.group, r.status, r.score?.correct ?? '', r.score?.formatValid ?? '', r.score?.sourceValid ?? '', r.contextChars ?? '', r.elapsedMs].join(','))]
  writeFileSync(join(output, 'results.csv'), csv.join('\n') + '\n')
  console.log(`${summary.label}\nArtifacts: ${output}`)
  if (results.some(r => r.status !== 'ok')) process.exitCode = 1
}

main().catch(error => {
  console.error(redact(error.message, [process.env.DEEPSEEK_API_KEY, process.env.GH_TOKEN, process.env.GITHUB_TOKEN]))
  process.exitCode = 1
})
