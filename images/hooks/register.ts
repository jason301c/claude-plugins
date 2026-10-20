import type { EngineInterface, Register } from 'claude-code'

const IMAGES_URL = 'https://openrouter.ai/api/v1/images'
const MODEL = 'openai/gpt-image-2.5-flare'
const QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const
const ASPECT_RATIOS = ['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'] as const
const MIME_BY_EXTENSION: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }
const EXTENSION_BY_MIME: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

type Input = { prompt: string; quality?: (typeof QUALITIES)[number]; aspect_ratio?: (typeof ASPECT_RATIOS)[number]; references?: string[] }

const DESCRIPTION = [
  'Generate an image with GPT Image 2.5 Flare through OpenRouter, or edit, restyle or combine images given as references. Each call is one paid request.',
  'quality defaults to low; raise it only when asked. aspect_ratio defaults to auto, where the model picks the shape.',
  'references: local file paths (png, jpg, webp) or https URLs, up to 16.',
  'The image is saved to disk and the result gives its path; Read that path to look at it.',
].join(' ')

const SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'What to draw, or how to change the references' },
    quality: { type: 'string', enum: QUALITIES, default: 'low' },
    aspect_ratio: { type: 'string', enum: ASPECT_RATIOS, default: 'auto' },
    references: { type: 'array', items: { type: 'string' }, maxItems: 16 },
  },
  required: ['prompt'],
  additionalProperties: false,
}

async function reference($: EngineInterface, value: string): Promise<string> {
  if (/^https:\/\//.test(value) || value.startsWith('data:image/')) return value
  const mime = MIME_BY_EXTENSION[value.split('.').pop()?.toLowerCase() ?? '']
  if (!mime) throw new Error(`Reference ${value} is not a png, jpg or webp file or an https URL`)
  const { base64 } = (await $.fs.read(value, { as: 'bytes' })) as { base64: string }
  return `data:${mime};base64,${base64}`
}

function explain(status: number, body: string): string {
  let message = ''
  try {
    message = String(JSON.parse(body)?.error?.message ?? '')
  } catch {}
  const text = message.replace(/[A-Za-z0-9+/]{256,}={0,2}/g, '[long value omitted]').slice(0, 500)
  const lowered = text.toLowerCase()
  if (status === 402 || /insufficient|credit|balance|payment required/.test(lowered)) return `OpenRouter credits have run out (HTTP ${status}). No image was generated.`
  if (/content[_ -]?policy|moderation|safety|content[_ -]?filter/.test(lowered)) return `Flare declined this prompt under its safety controls. No image was generated. ${text}`
  if (status === 401 || status === 403) return `OpenRouter rejected the API key (HTTP ${status}). Set it with: claude plugin configure images@jason301c`
  if (status === 429) return 'OpenRouter rate-limited the request. Wait a minute before trying again.'
  return `OpenRouter returned HTTP ${status}. No image was generated. ${text}`
}

async function generate($: EngineInterface, input: Input, apiKey: string, outputDir: string): Promise<string> {
  const references = input.references ?? []
  const body = {
    model: MODEL,
    prompt: input.prompt,
    n: 1,
    aspect_ratio: input.aspect_ratio ?? 'auto',
    quality: input.quality ?? 'low',
    background: 'opaque',
    ...(references.length
      ? { input_references: await Promise.all(references.map(async url => ({ type: 'image_url', image_url: { url: await reference($, url) } }))) }
      : {}),
  }
  const response = await $.http.fetch(IMAGES_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-OpenRouter-Title': 'Claude Code images' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(explain(response.status, response.text))
  const parsed = JSON.parse(response.text)
  const first = parsed?.data?.[0]
  const encoded = first?.b64_json
  if (typeof encoded !== 'string' || encoded === '') throw new Error('OpenRouter returned no image data.')
  const extension = EXTENSION_BY_MIME[first?.media_type] ?? 'png'
  const path = `${outputDir}/${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`
  // $.fs.write takes text only, so the bytes are decoded by the system's base64 tool
  await $.process.run(['/bin/mkdir', '-p', outputDir])
  const decoded = await $.process.run(['/usr/bin/base64', '-D', '-o', path], { stdin: encoded, timeoutMs: 60_000 })
  if (decoded.exitCode !== 0) throw new Error(`Could not write ${path}: ${decoded.stderr.trim()}`)
  const cost = parsed?.usage?.cost
  return [`Saved ${path}`, typeof cost === 'number' ? `Cost: $${cost.toFixed(4)}` : undefined].filter(Boolean).join('\n')
}

/** The key file used when the host passes no key (the desktop app does not pass the CLI's sensitive setting). */
const KEY_FILE = '.config/claude-images/.env'

/** OPENROUTER_API_KEY from ~/.config/claude-images/.env, read on each call so edits apply without a restart. */
async function keyFromFile($: EngineInterface, home: string): Promise<string> {
  if (home === '') return ''
  const file = await $.process.run(['/bin/cat', `${home}/${KEY_FILE}`], { timeoutMs: 5_000 })
  if (file.exitCode !== 0) return ''
  const line = file.stdout.split('\n').find((entry) => /^\s*OPENROUTER_API_KEY\s*=/.test(entry))
  return line ? line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '') : ''
}

export const register: Register = (on, options) => {
  const configuredKey = String(options.openRouterApiKey ?? '')

  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'generate_image', description: DESCRIPTION, inputSchema: SCHEMA })
    return next(e)
  })

  // Keep the tool in Claude's list rather than behind ToolSearch
  on('tool.describe', { tool: 'mcp__images__generate_image' }, ($, e) => ({ description: e.description, isDeferred: false }))

  on('tool.call', { tool: 'mcp__images__generate_image' }, async ($, e) => {
    const home = (await $.env.get('HOME')) ?? ''
    const apiKey = configuredKey || (await keyFromFile($, home))
    if (apiKey === '') return { deny: `No OpenRouter API key is set. Set it with: claude plugin configure images@jason301c, or OPENROUTER_API_KEY=... in ~/${KEY_FILE}` }
    const outputDir = String(options.outputDir ?? '') || `${home}/Pictures/claude-images`
    try {
      $.ui.status('Generating image')
      return { result: await generate($, e as unknown as Input, apiKey, outputDir) }
    } catch (error) {
      return { deny: error instanceof Error ? error.message : String(error) }
    } finally {
      $.ui.status(undefined)
    }
  })
}
