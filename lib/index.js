/**
 * dsh-notify — host half.
 *
 * Watches the process-wide durable session feed (`session/event` at the
 * profile root scope, so every top-level session is visible) and turns the
 * three "the model stopped and needs the human" moments into lightweight
 * notification records:
 *
 *   - turn/end        → the agent finished (kind `done`)
 *   - tool/call of ask_user_question → the agent asked the user (kind `question`)
 *   - approval/asked  → an approval decision is pending (kind `approval`)
 *
 * Records are pushed to the browser through a tiny same-origin SSE endpoint
 * (`/dsh-notify/feed`); the browser half (lib/client.js) renders them as
 * desktop notifications, a Settings → General row, and in-page fallback
 * toasts.
 *
 * The loader entry is exactly like dsh-skin's: this file is the host half of
 * a dual-face package and imports only Node builtins, so the bundle carries
 * no dependency on any @deepseek-ai package.
 */

import { appendFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-notify'

/** Hard dependency: the browser HTTP carrier used to expose the SSE feed. */
export const inject = ['webServer']

const NOTICE_KIND_DONE = 'done'
const NOTICE_KIND_QUESTION = 'question'
const NOTICE_KIND_APPROVAL = 'approval'

/** turn/end reasons that mean "the model stopped and the user should know". */
const DONE_REASONS = new Set(['completed', 'error', 'max-tokens', 'blocked'])

/** Model-facing tool name for asking the user a question. */
const ASK_TOOL = 'ask_user_question'

const MAX_NOTICES = 500
const MAX_SESSION_RECORDS = 800
const MAX_DEDUPE = 64

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const logPath = join(dshHome, 'dsh-notify.log')

/** Best-effort append-only JSONL activity log under $DSH_HOME. */
function writeLog(line) {
  appendFile(logPath, `${new Date().toISOString()} ${line}\n`).catch(() => {})
}

function clip(text, max) {
  if (typeof text !== 'string') return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return flat.slice(0, Math.max(0, max - 1)) + '…'
}

/** First textual content of a message-shaped object (tolerant of shape drift). */
function extractText(blocks) {
  if (typeof blocks === 'string') return clip(blocks, 400)
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (typeof block.text === 'string') parts.push(block.text)
    else if (typeof block.content === 'string') parts.push(block.content)
  }
  return clip(parts.join('\n'), 400)
}

/** The human-readable question from ask_user_question raw arguments JSON. */
function readAskQuestion(rawArgs) {
  let parsed = null
  if (typeof rawArgs === 'string' && rawArgs.trim()) {
    try { parsed = JSON.parse(rawArgs) } catch { parsed = null }
  } else if (rawArgs && typeof rawArgs === 'object') {
    parsed = rawArgs
  }
  if (!parsed || typeof parsed !== 'object') return ''
  const question = typeof parsed.question === 'string' ? parsed.question : ''
  const header = typeof parsed.header === 'string' ? parsed.header : ''
  const choice = question || header
  if (!choice) return ''
  const options = Array.isArray(parsed.options) ? parsed.options.length : 0
  return clip(choice + (options > 0 ? `（${options} 个选项）` : ''), 200)
}

export function apply(ctx) {
  const notices = [] // seq-ordered; newest at the tail
  const sinks = new Set() // live SSE ServerResponse objects
  const sessions = new Map() // sessionId -> per-session record
  let lastSeq = 0

  console.log('[dsh-notify] host loaded')
  writeLog('host loaded')

  function recordFor(session) {
    const id = session && typeof session.id === 'string' ? session.id : ''
    if (!id) return null
    let rec = sessions.get(id)
    if (!rec) {
      rec = {
        title: '', // session/title events
        user: '', // first user text (label fallback)
        tail: '', // last assistant text of the current turn
        basename: '', // cwd basename (label fallback)
        doneKeys: new Set(), // dedupe (turn, kind)
        asks: new Set(), // dedupe ask_user_question callIds
        approvals: new Set(), // dedupe approval ids
        seenAt: Date.now(),
      }
      try {
        const header = session && session.header
        const cwd = header && typeof header.cwd === 'string' ? header.cwd : ''
        if (cwd) rec.basename = basename(cwd)
      } catch { /* ignore */ }
      sessions.set(id, rec)
    }
    rec.seenAt = Date.now()
    if (sessions.size > MAX_SESSION_RECORDS) {
      let oldestKey = ''
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [key, value] of sessions) {
        if (value.seenAt < oldestAt) {
          oldestAt = value.seenAt
          oldestKey = key
        }
      }
      if (oldestKey) sessions.delete(oldestKey)
    }
    return rec
  }

  function labelFor(rec, sessionId) {
    if (rec.title) return rec.title
    if (rec.user) return rec.user
    if (rec.basename) return rec.basename
    return sessionId.length > 8 ? sessionId.slice(-8) : sessionId
  }

  function isTopLevel(session) {
    try {
      const header = session && session.header
      if (!header) return true
      if (header.origin === 'subagent') return false
      if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return false
    } catch { /* ignore */ }
    return true
  }

  function addDedupe(set, key) {
    if (set.has(key)) return false
    set.add(key)
    if (set.size > MAX_DEDUPE) {
      const first = set.values().next().value
      if (first !== undefined) set.delete(first)
    }
    return true
  }

  function enqueue(raw) {
    const notice = Object.assign({ seq: ++lastSeq, time: Date.now() }, raw)
    notices.push(notice)
    if (notices.length > MAX_NOTICES) notices.splice(0, notices.length - MAX_NOTICES)
    writeLog(`notice ${JSON.stringify(notice)}`)
    const frame = sseFrame(notice)
    for (const res of sinks) {
      try { res.write(frame) } catch { /* ignore */ }
    }
    return notice
  }

  ctx.on('session/event', (session, event) => {
    try {
      const rec = recordFor(session)
      if (!rec) return
      const type = event && event.type
      const data = (event && event.data) || {}
      const sid = typeof session.id === 'string' ? session.id : ''

      if (type === 'session/title') {
        const title = typeof data.title === 'string' ? data.title : ''
        if (title) rec.title = clip(title, 80)
        return
      }
      if (type === 'user/message') {
        if (!rec.user) rec.user = clip(extractText(data && data.content), 60)
        return
      }
      if (type === 'assistant/message') {
        const text = extractText(data && data.message && data.message.content)
        if (text) rec.tail = text
        return
      }
      if (type === 'turn/end') {
        if (!isTopLevel(session)) return
        const kind = data && data.reason && data.reason.kind
        if (!DONE_REASONS.has(kind)) return
        const turn = data.turn
        if (!addDedupe(rec.doneKeys, `t${String(turn)}:${kind}`)) return
        const preview = rec.tail
        rec.tail = ''
        enqueue({
          kind: NOTICE_KIND_DONE,
          sessionId: sid,
          label: labelFor(rec, sid),
          text: clip(preview, 220),
          sub: String(kind),
        })
        return
      }
      if (type === 'tool/call') {
        if (!isTopLevel(session)) return
        if (data.name !== ASK_TOOL) return
        const callId = data.callId !== undefined ? String(data.callId) : `${sid}#${event.seq}`
        if (!addDedupe(rec.asks, callId)) return
        enqueue({
          kind: NOTICE_KIND_QUESTION,
          sessionId: sid,
          label: labelFor(rec, sid),
          text: readAskQuestion(data.arguments),
          sub: '',
        })
        return
      }
      if (type === 'approval/asked') {
        if (!isTopLevel(session)) return
        const aid = data.id !== undefined ? String(data.id) : `a${event.seq}`
        if (!addDedupe(rec.approvals, aid)) return
        const tool = typeof data.toolName === 'string' ? data.toolName : ''
        const reason = typeof data.reason === 'string' ? data.reason : ''
        enqueue({
          kind: NOTICE_KIND_APPROVAL,
          sessionId: sid,
          label: labelFor(rec, sid),
          text: clip(tool && reason ? `${tool} — ${reason}` : tool || reason, 220),
          sub: tool,
        })
      }
    } catch (error) {
      console.error('[dsh-notify] session/event error', error)
      writeLog(`error ${String((error && error.stack) || error)}`)
    }
  })

  ctx.on('session/disposed', (session) => {
    try {
      const id = session && typeof session.id === 'string' ? session.id : ''
      if (id) sessions.delete(id)
    } catch { /* ignore */ }
  })

  const disposers = []

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-notify/feed',
    handler(req, res) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write('retry: 3000\n\n')
      const headerId = req.headers['last-event-id']
      let since = 0
      if (typeof headerId === 'string') {
        since = parseCursor(headerId)
      } else {
        try {
          const url = new URL(req.url || '/', 'http://localhost')
          since = parseCursor(url.searchParams.get('since'))
        } catch { /* ignore */ }
      }
      for (const notice of notices) {
        if (notice.seq > since) {
          try { res.write(sseFrame(notice)) } catch { break }
        }
      }
      if (res.destroyed) return
      sinks.add(res)
      const heartbeat = setInterval(() => {
        if (res.destroyed || res.writableEnded) {
          clearInterval(heartbeat)
          sinks.delete(res)
        } else {
          try { res.write(': ping\n\n') } catch { /* ignore */ }
        }
      }, 15000)
      res.on('close', () => {
        clearInterval(heartbeat)
        sinks.delete(res)
      })
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-notify/status',
    handler(req, res) {
      sendJson(res, 200, {
        ok: true,
        seq: lastSeq,
        buffered: notices.length,
        clients: sinks.size,
        pid: process.pid,
        uptimeMs: Math.round(process.uptime() * 1000),
      })
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-notify/test',
    handler(req, res) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      let body = ''
      let aborted = false
      req.setEncoding('utf8')
      req.on('error', () => { aborted = true })
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 8192) {
          aborted = true
          sendJson(res, 413, { ok: false, error: 'body too large' })
          req.destroy()
        }
      })
      req.on('end', () => {
        if (aborted) return
        try {
          const parsed = body ? JSON.parse(body) : {}
          const kind = parsed.kind === NOTICE_KIND_QUESTION || parsed.kind === NOTICE_KIND_APPROVAL
            ? parsed.kind
            : NOTICE_KIND_DONE
          const custom = typeof parsed.text === 'string' && parsed.text ? clip(parsed.text, 220) : ''
          const fallback = kind === NOTICE_KIND_QUESTION
            ? '这是一条测试提问通知 / test question'
            : kind === NOTICE_KIND_APPROVAL
              ? '这是一条测试批准通知 / test approval'
              : '这是一条测试完成通知 / test notification'
          const notice = enqueue({
            kind,
            sessionId: '',
            label: 'dsh-notify',
            text: custom || fallback,
            sub: 'test',
          })
          sendJson(res, 200, { ok: true, seq: notice.seq })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
        }
      })
    },
  }))

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* ignore */ }
    }
    for (const res of sinks) {
      try { res.end() } catch { /* ignore */ }
    }
    sinks.clear()
    writeLog('host disposed')
  }, 'dsh-notify: routes')
}

function sseFrame(notice) {
  return `id: ${notice.seq}\ndata: ${JSON.stringify(notice)}\n\n`
}

function parseCursor(value) {
  if (typeof value !== 'string') return 0
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function sendJson(res, code, payload) {
  try {
    if (res.headersSent) {
      res.end()
      return
    }
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify(payload))
  } catch { /* ignore */ }
}
