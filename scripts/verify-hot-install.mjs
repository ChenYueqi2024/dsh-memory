// Real AgentRegistry + AgentLoop + SystemPrompt + JSON backend; no model calls.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {existsSync,mkdirSync,writeFileSync} from 'node:fs'
const [pluginArg,storageArg]=process.argv.slice(2)
if(!pluginArg||!storageArg)throw new Error('Usage: node scripts/verify-hot-install.mjs <plugin-dist> <fresh-output-directory>')
const output=resolve(storageArg),storage=join(output,'storage')
if(existsSync(storage))throw new Error('Choose a fresh output directory')
mkdirSync(output,{recursive:true})
const requireHost=createRequire(join(process.cwd(),'package.json'))
const load=name=>import(pathToFileURL(requireHost.resolve('@deepseek-ai/'+name)).href)
const [{Context},llm,session,projection,prompt,tools,agents,loop,store,json,domain]=await Promise.all([
  load('cordis'),load('dsh-llm'),load('dsh-session'),load('dsh-session-projection'),load('dsh-system-prompt'),
  load('dsh-tools'),load('dsh-agent'),load('dsh-agent-loop'),load('dsh-storage'),load('dsh-storage-json'),load('dsh-storage-domain'),
])
const workspace=resolve(output,'project-a'),foreign=resolve(output,'project-b')
const backend=new json.JsonStorageBackend(storage)
try{
  const unit=await backend.kv.open({name:'dsh_memory',version:6,tables:['memories'],hasGlobal:false,layout:'per-record'})
  await unit.putRecord('memories','hotfix01',{id:'hotfix01',kind:'convention',text:'本项目使用 pnpm 管理依赖',createdAt:new Date().toISOString(),sourceSessionId:'seed',workspace:workspace.replaceAll('\\','/').toLowerCase(),confidence:1,pinned:true,approved:true,hits:0})
}finally{await backend.close()}
const ctx=new Context(),report={pass:false,plugin:resolve(pluginArg),realHost:true,modelCalls:0,checks:[]}
try{
  for(const mod of [llm,session,projection,prompt,tools,agents])await ctx.plugin(mod.default)
  await ctx.plugin(loop.default,{agents:[]})
  await ctx.plugin(store.default);await ctx.plugin(json,{root:storage});await ctx.plugin(domain,{backend:'json',routes:{}})
  const existing=await ctx.agentLoop.create('before-install',{provider:'unused',model:'unused'},{cwd:workspace})
  const other=await ctx.agentLoop.create('other-workspace',{provider:'unused',model:'unused'},{cwd:foreign})
  const sections=async agent=>(await agent.ctx.systemPrompt.assemble(agents.assembleContextFor(agent))).sections.filter(s=>s.name==='context:dsh-memory')
  assert.equal((await sections(existing)).length,0)
  const plugin=await import(pathToFileURL(resolve(pluginArg)).href)
  let fiber=ctx.plugin(plugin,{extractMinChars:100000})
  await fiber
  const current=await sections(existing)
  assert.equal(current.length,1,'pre-existing empty Agent must receive exactly one section after hot install')
  assert.match(current[0].text,/#hotfix01/);report.checks.push('pre-existing empty Agent receives stored memory before its first request')
  assert.equal((await sections(other))[0].text,'');report.checks.push('other workspace excluded')
  const fresh=await ctx.agentLoop.create('after-install',{provider:'unused',model:'unused'},{cwd:workspace})
  assert.match((await sections(fresh))[0].text,/#hotfix01/);report.checks.push('new Agent still receives memory')
  await fiber.dispose()
  assert.equal((await sections(existing)).length,0);assert.equal((await sections(fresh)).length,0)
  report.checks.push('unload removes both old and new Agent contributions')
  fiber=ctx.plugin(plugin,{extractMinChars:100000});await fiber
  for(const agent of [existing,fresh]){const s=await sections(agent);assert.equal(s.length,1);assert.match(s[0].text,/#hotfix01/)}
  report.checks.push('reload backfills once without duplicates');await fiber.dispose()
  report.pass=true
}catch(error){report.error=error.message;throw error}
finally{await ctx.fiber.dispose();writeFileSync(join(output,'verification.json'),JSON.stringify(report,null,2)+'\n')}
console.log(JSON.stringify(report))
