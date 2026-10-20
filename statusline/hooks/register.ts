import type { EngineInterface, Register } from 'claude-code'

const NODE_PATHS = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']
const MCP_EVERY_MS = 5 * 60 * 1000

type Spend = {
  spend: Record<string, number>
  cache: { tokens: number; at: number; ttlMs: number } | null
}

// One status line built from three parts, each refreshed on its own schedule.
let mcp = 'MCP checking'
let spend = ''
let cache: Spend['cache'] = null
let now = Date.now()

const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

// `250k toks cached 55:48`, counting down to when the prompt cache expires
function cacheText(): string {
  if (!cache) return ''
  const left = Math.max(0, Math.ceil((cache.at + cache.ttlMs - now) / 1000))
  if (!left) return `${tokens(cache.tokens)} toks cache expired`
  return `${tokens(cache.tokens)} toks cached ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}

let file: string | undefined
let shell = '/bin/sh'
let node: string | undefined
let hideInTerminal = false

// The figures are always written to `file`. With `terminalScript` set, a terminal leaves the drawing to the
// person's own statusLine command, which reads `file`, since a plugin's status line there carries a warning
// glyph and the plugin's name. Other surfaces show the plugin line.
const show = ($: EngineInterface) => {
  if (file) void $.fs.write(file, JSON.stringify({ mcp, spend, cache })).catch(() => undefined)
  $.ui.status(hideInTerminal ? undefined : [mcp, spend, cacheText()].filter(Boolean).join(' | '))
}

// Node from the login shell's PATH, else from the usual install folders
async function findNode($: EngineInterface): Promise<string | undefined> {
  const found = await $.process.run([shell, '-lc', 'command -v node'], { timeoutMs: 10_000 })
  const path = found.stdout.trim()
  if (found.exitCode === 0 && path.startsWith('/')) return path
  for (const candidate of NODE_PATHS) if (await $.fs.exists(candidate)) return candidate
  return undefined
}

// `claude mcp list` prints one line per server: `<name>: <url or command> - <status>`
async function refreshMcp($: EngineInterface): Promise<void> {
  const { exitCode, stdout } = await $.process.run([shell, '-lc', 'claude mcp list'], { timeoutMs: 60_000 })
  if (exitCode !== 0) {
    mcp = 'MCP status unavailable'
    return show($)
  }
  const connected: string[] = []
  const needsAuth: string[] = []
  const failed: string[] = []
  for (const line of stdout.split('\n')) {
    const match = /^(.+?): .* - (.+)$/.exec(line.trim())
    if (!match) continue
    const name = match[1].replace(/^claude\.ai /, '')
    if (match[2].includes('Connected')) connected.push(name)
    else if (match[2].includes('Needs authentication')) needsAuth.push(name)
    else failed.push(name)
  }
  const notes: string[] = []
  if (needsAuth.length) notes.push(`needs auth: ${needsAuth.join(', ')}`)
  if (failed.length) notes.push(`failed: ${failed.join(', ')}`)
  const count = `${connected.length} ${connected.length === 1 ? 'MCP' : 'MCPs'} connected`
  mcp = notes.length ? `${count} (${notes.join('; ')})` : count
  show($)
}

const usd = (n: number) => (n >= 100 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`)

let isSpendRunning = false

// spend.mjs sums this session's transcripts at list API prices (`session $1.77`) and reads the prompt cache
async function refreshSpend($: EngineInterface): Promise<void> {
  if (isSpendRunning) return
  isSpendRunning = true
  try {
    node ??= await findNode($)
    if (!node) {
      spend = 'spend unavailable (no node found)'
      return show($)
    }
    const ran = await $.process.run([node, `${$.plugin.root}/hooks/spend.mjs`, await $.session.id()], {
      timeoutMs: 60_000,
    })
    if (ran.exitCode !== 0) {
      spend = 'spend unavailable'
      return show($)
    }
    const result = JSON.parse(ran.stdout) as Spend
    const total = Object.values(result.spend).reduce((sum, n) => sum + n, 0)
    spend = `session ${usd(total)}`
    cache = result.cache
    show($)
  } finally {
    isSpendRunning = false
  }
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    hideInTerminal = options.terminalScript === true && (await $.session.surfaces()).includes('terminal')
    shell = (await $.env.get('SHELL')) || '/bin/sh'
    const home = (await $.env.get('HOME')) ?? ''
    file = `${home}/.cache/claude-statusline-${await $.session.id()}.json`
    show($)
    // Both checks take a moment, so they run on timers rather than holding the session's start
    $.clock.after(0, () => void refreshMcp($))
    $.clock.after(0, () => void refreshSpend($))
    $.clock.every(MCP_EVERY_MS, () => void refreshMcp($))
    $.clock.every(1000, () => {
      if (!cache || hideInTerminal) return
      now = Date.now()
      show($)
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refreshSpend($)
    return result
  })
}
