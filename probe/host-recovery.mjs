/** Real installed DSH agent-loop integration, no HTTP, credentials or production sessions.
 * node probe/host-recovery.mjs <installed-dsh-package-root>
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as failover from '../index.js'
const hostRoot = process.argv[2]
assert.ok(hostRoot, 'Pass installed DSH package root as first argument')
const hostRequire = createRequire(join(resolve(hostRoot), 'package.json'))
const load = name => import(pathToFileURL(hostRequire.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const llmModule = await load('@deepseek-ai/dsh-llm')
const { defineTool } = await load('@deepseek-ai/dsh-tools')
const previousHome = process.env.DSH_HOME
const home = mkdtempSync(join(tmpdir(), 'dsh-host-recovery-'))
process.env.DSH_HOME = home
const ctx = new Context()
const handles = []
try {
  for (const name of ['dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-agent-loop']) {
    ctx.plugin((await load('@deepseek-ai/' + name)).default, {})
  }
  await new Promise(resolve => ctx.inject(['agentLoop'], resolve))
  let executions = 0
  ctx.tools.register(defineTool({ name: 'count_once', description: 'Count one completed side effect', parameters: {}, output: { schema: { type: 'number' } }, execute: async () => ++executions }))
  const attempts = []
  const bySession = new Map()
  const failureSessions = []
  ctx.on('agent/request-error', (payload, next) => { failureSessions.push(payload.agent?.session.id); return next() })
  let failed = 0
  let cancelAgent
  class Mock extends llmModule.LlmAdapter {
    async *stream(options) {
      attempts.push(options.provider)
      const sessionAttempts = bySession.get(options.sessionId) ?? []
      sessionAttempts.push(options.provider)
      bySession.set(options.sessionId, sessionAttempts)
      if (executions === 0) {
        const block = { type: 'tool-call', id: 'count-call', name: 'count_once', arguments: '{}' }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else if (options.provider === 'a' || options.sessionId === 'host-exhausted-test') {
        if (options.sessionId === 'host-cancel-test') setTimeout(() => cancelAgent.cancel({ kind: 'user' }), 5)
        failed++
        // A failed stream's tool block must never dispatch before retry.
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'failed-call-' + failed, name: 'count_once', arguments: '{}' } }
        if (options.sessionId === 'host-throw-test') throw new llmModule.LlmError('server_error: failed after partial stream', 'PI_AI_ERROR')
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'PI_AI_ERROR', message: failed === 1 ? 'server_error: Our servers are currently overloaded. Please try again later.' : 'server_error: An error occurred while processing your request.' } } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'recovered' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'recovered' } }
        yield { type: 'finish', reason: { kind: 'completed' } }
      }
    }
  }
  ctx.llm.registerAdapter(['a', 'b'], new Mock())
  ctx.plugin(failover, { minSwitchIntervalMs: 0, retryPolicies: { SERVER: { attempts: 1, delayMs: 20, budgetMs: 20 } }, tiers: [{ tier: 1, enabled: true, entries: [{ id: 'a', route: 'a', model: 'm' }, { id: 'b', route: 'b', model: 'm' }] }] })
  const events = []
  ctx.on('session/event', (_session, event) => { events.push(event) })
  const handle = await ctx.agents.create({ sessionId: 'host-recovery-test', agentOptions: { provider: 'a', model: 'm' } })
  handles.push(handle)
  handle.agent.followup(llmModule.createUserMessage({ content: [{ type: 'text', text: 'perform work' }] }))
  await handle.agent.whenIdle()
  assert.equal(executions, 1, 'completed tool side effect must not replay')
  assert.deepEqual(attempts, ['a', 'a', 'a', 'b'])
  assert.equal(events.filter(e => e.type === 'user/message').length, 1, 'retry must not duplicate user input')
  const end = events.filter(e => e.type === 'turn/end').at(-1)
  assert.equal(end.data.reason.kind, 'completed')
  assert.equal(handle.agent.session.requestHeader().config.provider, 'b')
  handle.agent.followup(llmModule.createUserMessage({ content: [{ type: 'text', text: 'continue' }] }))
  await handle.agent.whenIdle()
  assert.equal(attempts.at(-1), 'b', 'recovered request header must persist into next turn')
  await Promise.all(['host-concurrent-1', 'host-concurrent-2', 'host-throw-test'].map(async sessionId => {
    const parallelHandle = await ctx.agents.create({ sessionId, agentOptions: { provider: 'a', model: 'm' } })
    handles.push(parallelHandle)
    parallelHandle.agent.followup(llmModule.createUserMessage({ content: [{ type: 'text', text: 'parallel recovery' }] }))
    await parallelHandle.agent.whenIdle()
    assert.deepEqual(bySession.get(sessionId), ['a', 'a', 'b'], 'each concurrent agent owns its retry budget and target')
    assert.equal(parallelHandle.agent.session.requestHeader().config.provider, 'b')
    assert.ok(failureSessions.includes(sessionId), 'host dispatcher must inject agent identity')
  }))
  assert.ok(failureSessions.every(Boolean))
  for (const [sessionId, expected] of [['host-exhausted-test', 'error'], ['host-cancel-test', 'aborted']]) {
    const testHandle = await ctx.agents.create({ sessionId, agentOptions: { provider: 'a', model: 'm' } })
    handles.push(testHandle)
    cancelAgent = testHandle.agent
    const before = attempts.length
    testHandle.agent.followup(llmModule.createUserMessage({ content: [{ type: 'text', text: 'exercise terminal state' }] }))
    await testHandle.agent.whenIdle()
    assert.equal(events.filter(e => e.type === 'turn/end').at(-1).data.reason.kind, expected)
    if (expected === 'aborted') assert.equal(attempts.length - before, 1, 'cancel during backoff must not dispatch again')
    else assert.equal(attempts.length - before, 3, 'exhaustion must remain bounded')
  }
  assert.equal(executions, 1)
  console.log('PASS real agent-loop: tool executes once; same step retries/fails over; input stays single; next turn keeps b; terminal states completed/error/aborted verified')
} finally {
  for (const handle of handles) await handle.dispose()
  await ctx.fiber.dispose()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
}
