import { atom, read, update } from 'claude-code'
import type { ElementTable, Register } from 'claude-code'

import type { Progress, ProgressState } from '../types'

const STATES = ['working', 'waiting', 'failed', 'done'] as const
const LABELS: Record<ProgressState, string> = { working: 'Working', waiting: 'Needs you', failed: 'Failed', done: 'Done' }
const COLORS: Record<ProgressState, string> = { working: '#7C6CF2', waiting: '#E09A1E', failed: '#E5484D', done: '#30A46C' }
// 24-unit icon paths drawn at half size inside the knob
const ICONS: Partial<Record<ProgressState, string>> = {
  waiting: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01',
  failed: 'M18 6 6 18M6 6l12 12',
  done: 'M20 6 9 17l-5-5',
}
const TRACK_HEIGHT = 22
const STOPPED_COLOR = '#8A8984'
// A space as wide as a digit, so ' 5%' and '100%' take the same room
const FIGURE_SPACE = String.fromCharCode(0x2007)

// Terminal band: a Raster of braille cells on a dotted rail, repainted by
// $.ui.blit between redraws. It draws what the desktop's SVG draws: pixels that fade on and off over the
// filled part, denser towards the head, a pill at the head with the state's label, and a glide between values
const RASTER_KEY = 'progress-track'
const FRAME_MS = 66
const GLIDE_MS = 450
const TERMINAL_LABELS: Record<ProgressState, string> = { working: 'Working', waiting: 'Needs you', failed: '\u2715 Failed', done: '\u2713 Done' }
const TRACK_GLYPH = 0x2812 // one row of dots through the middle of the cell
// Braille dot bits by [dot column][dot row]
const DOTS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]
// At the tail, the share of dots that exist and the share of those mostly lit; both reach 1 at the head
const DOT_DENSITY = 0.55
const DOT_LIT = 0.6
const TRACK_COLOR = 0x6e6d69
const KNOB_TEXT_COLOR = 0xffffff
const CLOCK_SECONDS = [2.1, 3.3, 2.7, 4.5, 1.8, 3.9, 5.7, 2.4]

const current = atom({ plugin: 'progress', key: 'current' } as const, null)

// The percent last drawn, so the next drawing glides from it; a reload starts it over
let lastPercent: number | null = null

// Whether a job is large shows in how long it runs, not in how it starts, and Claude decides at the start.
// So the band is asked for again mid-turn: once when the main loop passes NUDGE_AFTER_CALLS tool calls,
// and in the engine's own reminder that the person has not heard from Claude in a while
const NUDGE_AFTER_CALLS = 15
let turnCalls = 0
let isNudged = false

const TOOL = 'mcp__progress__update'

// The tool says what a call does; when to call it lives in GUIDANCE, which the system prompt carries
const DESCRIPTION = [
  'Set the progress band above the prompt, which shows how far along a large request is.',
  'Only for large jobs that pass through several distinct phases; never for questions, lookups, single edits or short investigations, however many tool calls they take.',
  'Update it when a phase ends, not on every step, and end the job with done or failed.',
].join(' ')

const SCHEMA = {
  type: 'object',
  properties: {
    percent: { type: 'integer', minimum: 0, maximum: 100, description: 'Your estimate of how much of the whole request is done' },
    state: {
      type: 'string',
      enum: STATES,
      description: 'working while you make progress, including fixing your own errors; waiting when you have asked the person to decide something; failed when you stop without finishing; done when the request is complete',
    },
    text: { type: 'string', maxLength: 80, description: 'The current phase in a few plain words, such as "Writing the migration"' },
  },
  required: ['percent', 'state', 'text'],
  additionalProperties: false,
}

const GUIDANCE = `# Progress band

The progress band (\`${TOOL}\`) shows the person how far along a large piece of work is. It tracks the whole request, not the steps inside it.

Use it only when the request is a large job: one you expect to take many minutes and to move through several distinct phases, such as building a feature end to end, a refactor or migration across many files, a long investigation, a batch operation over many records, or a cycle of tests and fixes. Most requests do not qualify. Answering a question, looking something up, a single edit, or a short investigation never gets a band, however many tool calls it takes. A request that turns into a large job partway through gets the band from that point.

When it applies:
- Set it once you know the shape of the work, before the first substantial phase, with a low percent and that phase as the text.
- Update it when a phase ends or the plan changes, not on every tool call. A job usually gets three to six updates.
- percent is your estimate of how much of the whole request is done. Lower it only when the scope grows.
- text names the current phase in a few plain words, such as "Writing the migration" or "Running type-check".
- Set waiting when you stop to ask the person for a decision, done at 100 when the request is complete, and failed when you stop without finishing. Set the final state before your closing message.`

const NUDGE = `This turn has made ${NUDGE_AFTER_CALLS} tool calls without the progress band. If it is a large job with phases still ahead, set the band now with ${TOOL}. If it is nearly finished, carry on without it.`
const SILENT_SET = `If this has become a large job with phases still ahead, also set the progress band with ${TOOL}: it stays in view, while a line in the chat scrolls away.`
const SILENT_UPDATE = 'If the phase has changed since the progress band was last set, update it as well.'

// A band the person can see moving: set, and neither finished nor greyed out by an ended turn
const isShowing = (progress: Progress | null) => progress !== null && !progress.isStopped && (progress.state === 'working' || progress.state === 'waiting')

const escape = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
// Deterministic noise in [0, 1), so the pixel texture stays put between redraws
const noise = (a: number, b: number) => {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
  return x - Math.floor(x)
}

function trackSvg(progress: Progress, width: number): string {
  const h = TRACK_HEIGHT
  const color = progress.isStopped ? STOPPED_COLOR : COLORS[progress.state]
  const head = (progress.percent / 100) * width
  const from = lastPercent === null ? head : (lastPercent / 100) * width
  const glides = Math.abs(from - head) > 0.5
  const ease = 'calcMode="spline" keyTimes="0;1" keySplines=".2 .8 .2 1"'

  // Pixels stay in place and fade on and off, each on one of eight slow clocks with its own length and
  // offset; some are lit most of the time, some dark, and both are denser towards the head. Slower still
  // while Claude waits, still once it has finished or failed
  let pixels = ''
  for (let column = 0; column * 3 < head; column++) {
    const x = column * 3
    const nearness = Math.pow(Math.min(1, (x + 1.5) / Math.max(head, 1)), 1.5)
    for (let row = 0; row < 7; row++) {
      if (noise(column, row) > 0.25 + 0.75 * nearness) continue
      const clock = Math.floor(noise(row + 13, column + 5) * 8)
      const isMostlyOn = noise(column + 3, row + 9) < 0.35 + 0.5 * nearness
      pixels += `<rect x="${x}" y="${1 + row * 3}" class="c${clock} ${isMostlyOn ? 'on' : 'off'}"/>`
    }
  }
  const pace = progress.isStopped ? 0 : progress.state === 'working' ? 1 : progress.state === 'waiting' ? 2 : 0
  const clocks =
    pace === 0
      ? ''
      : [2.1, 3.3, 2.7, 4.5, 1.8, 3.9, 5.7, 2.4]
          .map((seconds, i) => `.c${i}{animation-duration:${(seconds * pace).toFixed(2)}s;animation-delay:-${(((i * 1.1) % 3.9) * pace).toFixed(2)}s}`)
          .join('') + '.on{animation-name:on}.off{animation-name:off}rect[class]{animation-timing-function:ease-in-out;animation-iteration-count:infinite}'

  // Knob at the head: the state's icon and label in a pill
  const label = progress.isStopped ? 'Stopped' : LABELS[progress.state]
  const icon = progress.isStopped ? undefined : ICONS[progress.state]
  const iconWidth = icon ? 16 : 0
  const knobWidth = Math.round(20 + iconWidth + label.length * 6.6)
  const clamp = (x: number) => Math.max(knobWidth / 2, Math.min(width - knobWidth / 2, x))
  const left = -knobWidth / 2 + 10
  const knob =
    `<rect x="${-knobWidth / 2}" width="${knobWidth}" height="${h}" rx="${h / 2}" fill="${color}"/>` +
    (icon ? `<path d="${icon}" transform="translate(${left} 5) scale(.5)" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>` : '') +
    `<text x="${left + iconWidth}" y="${h / 2 + 4.2}" class="k">${escape(label)}</text>`

  // The interactive Svg draws in a sandboxed frame. A frame whose color scheme differs from the app's
  // paints an opaque white page behind the drawing, so the drawing declares both schemes
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}"><style>
:root,svg{color-scheme:light dark;background:transparent}
rect[class]{width:2px;height:2px;fill:${color};fill-opacity:.7}.off{opacity:0}
${clocks}
@keyframes on{0%,45%,100%{opacity:1}75%{opacity:0}}
@keyframes off{0%,45%,100%{opacity:0}75%{opacity:1}}
@media (prefers-reduced-motion:reduce){rect[class]{animation:none}}
.k{font:500 12px ui-sans-serif,system-ui,-apple-system,sans-serif;fill:#fff}
</style><defs>
<clipPath id="track"><rect width="${width}" height="${h}" rx="${h / 2}"/></clipPath>
<clipPath id="fill"><rect width="${head.toFixed(1)}" height="${h}">${glides ? `<animate attributeName="width" from="${from.toFixed(1)}" to="${head.toFixed(1)}" dur=".45s" ${ease} fill="freeze"/>` : ''}</rect></clipPath>
<linearGradient id="base" x1="0" x2="${Math.max(head, 1).toFixed(1)}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${color}" stop-opacity=".05"/><stop offset="1" stop-color="${color}" stop-opacity=".35"/></linearGradient>
</defs><g clip-path="url(#track)"><rect width="${width}" height="${h}" fill="#808080" fill-opacity=".16"/>
<g clip-path="url(#fill)"><rect width="${head.toFixed(1)}" height="${h}" fill="url(#base)"/>${pixels}</g></g>
<g transform="translate(${clamp(head).toFixed(1)} 0)">${glides ? `<animateTransform attributeName="transform" type="translate" from="${clamp(from).toFixed(1)} 0" to="${clamp(head).toFixed(1)} 0" dur=".45s" ${ease} fill="freeze"/>` : ''}${knob}</g></svg>`
}

const hex = (color: string) => parseInt(color.slice(1), 16)
// a toward b by t in [0, 1], per channel
const mix = (a: number, b: number, t: number) => {
  let out = 0
  for (const shift of [16, 8, 0]) {
    const x = (a >> shift) & 0xff
    const y = (b >> shift) & 0xff
    out |= Math.round(x + (y - x) * t) << shift
  }
  return out
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
// Standard padded base64, as Raster cells are packed
function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    out += BASE64[(n >> 18) & 63]! + BASE64[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? BASE64[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? BASE64[n & 63]! : '='
  }
  return out
}

// What the terminal band shows now and how its animation stands; a reload starts it over
type Track = { requestId: string; columns: number; progress: Progress; head: number; glideFrom: number; glideFrame: number }
let track: Track | null = null
let frame = 0
let ticker: { cancel: () => void } | null = null

const glideFrames = Math.round(GLIDE_MS / FRAME_MS)
const isAnimated = (progress: Progress) => !progress.isStopped && (progress.state === 'working' || progress.state === 'waiting')

// The head in dot columns at frame `at`, eased out from where the last value left it
function headAt(t: Track, at: number): number {
  const done = Math.min(1, (at - t.glideFrame) / glideFrames)
  const eased = 1 - Math.pow(1 - done, 4)
  return t.glideFrom + (t.head - t.glideFrom) * eased
}

function paintTrack(t: Track, at: number): string {
  const { columns, progress } = t
  const color = progress.isStopped ? hex(STOPPED_COLOR) : hex(COLORS[progress.state])
  const gray = hex(STOPPED_COLOR)
  const head = headAt(t, at)
  const pace = isAnimated(progress) ? (progress.state === 'working' ? 1 : 2) : 0
  const seconds = (at * FRAME_MS) / 1000
  const words = new Uint32Array(columns * 3)
  // The pill rides the head and stays inside the track; the fill's gradient peaks where the pill begins
  const label = ` ${progress.isStopped ? 'Stopped' : TERMINAL_LABELS[progress.state]} `
  const hasKnob = label.length <= columns
  const knobStart = hasKnob ? Math.round(Math.max(label.length / 2, Math.min(columns - label.length / 2, head)) - label.length / 2) : columns
  const peak = Math.max(1, Math.min(head, knobStart) * 2)

  for (let cell = 0; cell < columns; cell++) {
    const i = cell * 3
    words[i + 2] = 0x01000000
    if (cell + 0.5 > head) {
      words[i] = TRACK_GLYPH
      words[i + 1] = TRACK_COLOR
      continue
    }
    // Two dot columns and four dot rows to a cell, as the desktop's grid of pixels: denser, more often lit
    // and brighter towards the head, each dot fading on or off for a stretch of one of eight clocks
    let bits = 0
    for (let side = 0; side < 2; side++) {
      const column = cell * 2 + side
      if (column + 0.5 > head * 2) continue
      const nearness = Math.min(1, (column + 1) / peak)
      for (let row = 0; row < 4; row++) {
        if (noise(column, row) > DOT_DENSITY + (1 - DOT_DENSITY) * nearness) continue
        let isOn = noise(column + 3, row + 9) < DOT_LIT + (1 - DOT_LIT) * nearness
        if (pace > 0) {
          const clock = Math.floor(noise(row + 13, column + 5) * 8)
          const period = (CLOCK_SECONDS[clock] ?? 3) * pace
          const phase = (seconds / period + noise(clock, column % 7)) % 1
          if (phase > 0.55 && phase < 0.9) isOn = !isOn
        }
        if (isOn) bits |= DOTS[side]?.[row] ?? 0
      }
    }
    const nearness = Math.min(1, (cell * 2 + 2) / peak)
    words[i] = 0x2800 | bits
    words[i + 1] = mix(gray, color, 0.55 + 0.45 * nearness)
  }

  // The pill breathes while Claude waits on the person
  if (hasKnob) {
    const breath = pace === 2 ? 0.5 - 0.5 * Math.cos((seconds / 1.6) * Math.PI) : 0
    const knob = mix(color, gray, 0.35 * breath)
    for (let k = 0; k < label.length; k++) {
      const i = (knobStart + k) * 3
      words[i] = label.charCodeAt(k)
      words[i + 1] = KNOB_TEXT_COLOR
      words[i + 2] = knob
    }
  }
  return base64(new Uint8Array(words.buffer))
}

function stopTicker() {
  ticker?.cancel()
  ticker = null
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'update', description: DESCRIPTION, inputSchema: SCHEMA })
    return next(e)
  })

  on('tool.describe', { tool: TOOL }, ($, e) => ({ description: e.description, isDeferred: false }))

  // When to use the band goes in the system prompt, where it weighs more than a tool description; only
  // for requests that offer the tool and sessions that draw it
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(TOOL) || e.traits.includes('print') || e.traits.includes('bare')) return composed
    return { sections: [...composed.sections, { id: 'progress:guidance', text: GUIDANCE, scope: 'session' as const }] }
  })

  on('turn.start', async ($, e, next) => {
    turnCalls = 0
    isNudged = false
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const called = await next(e)
    if (e.agentId || e.tool === TOOL || typeof called.deny === 'string') return called
    turnCalls += 1
    if (isNudged || turnCalls < NUDGE_AFTER_CALLS) return called
    isNudged = true
    if (isShowing(await read($, current))) return called
    return { ...called, context: [...(called.context ?? []), NUDGE] }
  })

  // The engine asks Claude to say in a few words what it is doing; that is the moment the band is for
  on('prompt.attachment', { type: 'silent_turn_reminder' }, async ($, e, next) => {
    const reminder = await next(e)
    if (e.agentId || reminder.text === null) return reminder
    const progress = await read($, current)
    return { text: `${reminder.text} ${isShowing(progress) ? SILENT_UPDATE : SILENT_SET}` }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    // Subagents report to their caller, not to the person
    if (e.agentId) return { deny: 'Only the main conversation updates the progress band.' }
    const input = e as unknown as Progress
    const percent = Math.max(0, Math.min(100, Math.round(Number(input.percent) || 0)))
    const state = STATES.includes(input.state) ? input.state : 'working'
    const text = String(input.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
    await update($, current, () => ({ percent, state, text }))
    return { result: 'ok' }
  })

  // A finished, failed or stopped task's band goes away when the person sends the next prompt
  on('prompt.submit', async ($, e, next) => {
    const progress = await read($, current)
    if (progress && (progress.isStopped || progress.state === 'done' || progress.state === 'failed')) await update($, current, () => null)
    return next(e)
  })

  // A turn that ends (answered, interrupted or failed) while the band still says working leaves nobody
  // working, so the band stops animating and greys out
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && (await read($, current))?.state === 'working') await update($, current, p => (p ? { ...p, isStopped: true } : p))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const progress = await read($, current)
    if (progress === null || e.props.hasSurvey) {
      if (e.surface === 'terminal') {
        stopTicker()
        track = null
      }
      return next(e)
    }
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const percent = <Text dimColor>{`${String(progress.percent).padStart(3, FIGURE_SPACE)}%`}</Text>
    const close = <Button key="progress-close" plain dimColor label="✕" onPress={() => update($, current, () => null)} />

    if (e.surface === 'terminal') {
      // The table holds every element name, the terminal's missing Svg as a fragment, so branch on the surface
      const { Raster } = elements as ElementTable<'terminal'>
      const bodyColumns = e.props.bodyColumns || 80
      const columns = Math.max(14, Math.min(48, Math.round(bodyColumns * 0.4)))
      const head = (progress.percent / 100) * columns
      // A new value glides from wherever the head is drawn now; a first drawing starts at its value
      const shown = track && track.columns === columns ? headAt(track, frame) : head
      const isNewValue = !track || track.progress.percent !== progress.percent || track.columns !== columns
      track = {
        requestId: e.requestId,
        columns,
        progress,
        head,
        glideFrom: isNewValue ? shown : track!.glideFrom,
        glideFrame: isNewValue ? frame : track!.glideFrame,
      }
      if (!ticker && (isAnimated(progress) || Math.abs(shown - head) > 0.01)) {
        ticker = $.clock.every(FRAME_MS, () => {
          frame += 1
          const t = track
          if (!t) return stopTicker()
          const isGliding = frame - t.glideFrame <= glideFrames
          void $.ui.blit({ requestId: t.requestId, key: RASTER_KEY, cells: paintTrack(t, frame), columns: t.columns, rows: 1 }).then(result => {
            if (result.deny && ticker) stopTicker()
          })
          // A finished, failed or stopped band holds still once its last glide lands
          if (!isAnimated(t.progress) && !isGliding) stopTicker()
        })
      }
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Box flexShrink={1}>
            <Text wrap="truncate-end">{progress.text}</Text>
          </Box>
          <Box flexGrow={1} />
          <Raster key={RASTER_KEY} columns={columns} rows={1} cells={paintTrack(track, frame)} />
          {percent}
          {close}
        </Box>
      )
    }

    // The desktop reports about 8 CSS pixels per column; the text, percent and close button keep the rest
    const { Svg } = elements as ElementTable<'desktop'>
    const total = Math.max(320, (e.props.bodyColumns || 100) * 8)
    const width = Math.max(160, Math.min(520, Math.round(total * 0.45)))
    const drawn = trackSvg(progress, width)
    lastPercent = progress.percent
    // Each item sits in its own centred box: bare Text and Button rows otherwise ride their own line boxes
    // and end up above or below the bar
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Box alignSelf="center" flexShrink={1}>
          <Text wrap="truncate-end">{progress.text}</Text>
        </Box>
        <Box flexGrow={1} />
        <Box alignSelf="center">
          <Svg source={drawn} alt={`${progress.isStopped ? 'Stopped' : LABELS[progress.state]}, ${progress.percent}%: ${progress.text}`} width={width} height={TRACK_HEIGHT} isInteractive />
        </Box>
        <Box alignSelf="center">{percent}</Box>
        <Box alignSelf="center">{close}</Box>
      </Box>
    )
  })
}
