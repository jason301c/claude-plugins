// Sums API-equivalent spend per model from Claude Code transcripts.
// argv: <sessionId>. Prints { spend: model -> USD (subagents included), cache } where cache is the main
// transcript's latest request: tokens in the prompt cache, when it was made, and the cache's lifetime.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const [sessionId] = process.argv.slice(2)
const ROOT = path.join(os.homedir(), '.claude', 'projects')
const CACHE = path.join(os.homedir(), '.cache', 'claude-model-spend-v2.json')

// $ per million tokens: input, output, cache read. Cache writes are 1.25x (5m) or 2x (1h) input.
const PRICES = [
  [/fable-5-1|mythos-5-1/, 10, 50, 0.25],
  [/fable|mythos/, 10, 50, 1],
  [/opus-5-5/, 4, 20, 0.2],
  [/opus/, 5, 25, 0.5],
  [/sonnet-5/, 2, 10, 0.2],
  [/sonnet/, 3, 15, 0.3],
  [/haiku/, 1, 5, 0.1],
]

function cost(model, u) {
  const row = PRICES.find(([re]) => re.test(model))
  if (!row) return 0
  const [, inp, out, read] = row
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const w5m = (u.cache_creation_input_tokens ?? 0) - w1h
  const usd =
    (u.input_tokens ?? 0) * inp +
    (u.output_tokens ?? 0) * out +
    (u.cache_read_input_tokens ?? 0) * read +
    w5m * inp * 1.25 +
    w1h * inp * 2
  return (usd / 1e6) * (u.speed === 'fast' ? 2 : 1)
}

let cache = {}
try {
  cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'))
} catch {}

function walk(dir, out) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name)
    if (d.isDirectory()) walk(p, out)
    else if (d.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

// Reads only the bytes appended since the last run; a file that shrank is reread.
function scan(file, stat) {
  let entry = cache[file]
  if (!entry || stat.size < entry.offset) entry = { offset: 0, msgs: {} }
  if (stat.size > entry.offset) {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(stat.size - entry.offset)
    fs.readSync(fd, buf, 0, buf.length, entry.offset)
    fs.closeSync(fd)
    const end = buf.lastIndexOf(10)
    if (end >= 0) {
      for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
        if (!line.includes('"usage"')) continue
        let row
        try {
          row = JSON.parse(line)
        } catch {
          continue
        }
        const m = row.message
        if (row.type !== 'assistant' || !m?.usage || !m.id || !m.model?.startsWith('claude')) continue
        const u = m.usage
        const cached = (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
        const ttlMs = (u.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0 ? 3600_000 : (u.cache_creation?.ephemeral_5m_input_tokens ?? 0) > 0 ? 300_000 : 0
        entry.msgs[m.id] = [Date.parse(row.timestamp) || stat.mtimeMs, m.model, cost(m.model, u), cached, ttlMs]
      }
      entry.offset += end + 1
    }
  }
  entry.mtimeMs = stat.mtimeMs
  cache[file] = entry
  return entry
}

// The session's transcript and its subagents' transcripts, in whichever project folder holds them.
function sessionFiles() {
  const files = []
  for (const project of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const dir = path.join(ROOT, project.name)
    if (fs.existsSync(path.join(dir, `${sessionId}.jsonl`))) files.push(path.join(dir, `${sessionId}.jsonl`))
    if (fs.existsSync(path.join(dir, sessionId))) walk(path.join(dir, sessionId), files)
  }
  return files
}

const spend = {}
const live = {}
let promptCache = null
for (const file of sessionFiles()) {
  const entry = scan(file, fs.statSync(file))
  live[file] = entry
  for (const [, model, usd] of Object.values(entry.msgs)) spend[model] = (spend[model] ?? 0) + usd
  if (path.basename(file) !== `${sessionId}.jsonl`) continue
  // A request that only read the cache does not say its lifetime, so take it from the latest write.
  const msgs = Object.values(entry.msgs).sort((x, y) => x[0] - y[0])
  const last = msgs.at(-1)
  const ttlMs = msgs.findLast(msg => msg[4])?.[4] ?? 300_000
  if (last?.[3]) promptCache = { tokens: last[3], at: last[0], ttlMs }
}

fs.mkdirSync(path.dirname(CACHE), { recursive: true })
fs.writeFileSync(CACHE, JSON.stringify(live))
process.stdout.write(JSON.stringify({ spend, cache: promptCache }))
