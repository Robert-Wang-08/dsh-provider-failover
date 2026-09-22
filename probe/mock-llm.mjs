/**
 * M0 探针用模拟 LLM 端点（无依赖）。
 *   node mock-llm.mjs [port]
 * 路由：
 *   POST /quota/v1/chat/completions    -> 402 Insufficient Balance        （归一化 QUOTA）
 *   POST /auth/v1/chat/completions     -> 401 Invalid API key             （归一化 AUTH）
 *   POST /overload/v1/chat/completions -> 503 servers currently overloaded（归一化 SERVER）
 *   POST /rate/v1/chat/completions     -> 429 rate limit exceeded         （归一化 RATE_LIMIT）
 *   POST /ok/v1/chat/completions       -> 200 SSE 最小可用流
 * key 维度（T1.5）：请求头 Authorization 为 `Bearer sk-probe-bad…` 时，/ok 也回 402 ——
 * 用于验证「同 baseURL 两把 key、一坏一好」时轮换后生效的确实是第二把 key。
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 8799)
const BAD_BEARER_RE = /^Bearer\s+sk-probe-bad/

const FAILURES = {
  quota: [402, { error: { message: '402 Insufficient Balance', type: 'insufficient_quota', code: 'insufficient_quota' } }],
  auth: [401, { error: { message: '401 Invalid API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }],
  overload: [503, { error: { message: '503 Our servers are currently overloaded. Please try again later.', type: 'server_error', code: 'server_error' } }],
  rate: [429, { error: { message: '429 rate limit exceeded, too many requests', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }],
}

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

const server = createServer((req, res) => {
  const url = req.url ?? ''
  if (req.method !== 'POST') {
    res.writeHead(405).end('method not allowed')
    return
  }
  const kind = url.split('/')[1]
  const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : ''
  const badKey = BAD_BEARER_RE.test(auth)
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    process.stdout.write(`[mock] ${req.method} ${url} kind=${kind} auth=${auth.length > 0 ? auth.slice(0, 18) + '…' : '(none)'}${badKey ? ' BAD-KEY' : ''}\n`)
    if (kind === 'ok' && badKey) {
      // 坏 key 打到正常端点：按额度失败应答（验证线上请求确实携带了被轮换的引用值）。
      res.writeHead(FAILURES.quota[0], { 'content-type': 'application/json' })
      res.end(JSON.stringify(FAILURES.quota[1]))
      return
    }
    if (kind === 'ok') {
      sse(res, [
        { id: 'probe-1', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'probe-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] },
        { id: 'probe-1', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'probe-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ])
      return
    }
    const failure = FAILURES[kind]
    if (failure === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `no mock route for ${kind}` } }))
      return
    }
    res.writeHead(failure[0], { 'content-type': 'application/json' })
    res.end(JSON.stringify(failure[1]))
  })
})

server.listen(port, '127.0.0.1', () => process.stdout.write(`[mock] listening on http://127.0.0.1:${port}\n`))
