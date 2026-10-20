import type { EngineInterface, Register } from 'claude-code'

type Skill = { name: string; description: string; dir: string; body: string }

// Skills found under .agents/skills, by name, for the working directory last scanned
let skills = new Map<string, Skill>()
let scannedCwd: string | undefined

// Reads `key: value` pairs from SKILL.md frontmatter, including `>` and `|` block values
function parse(text: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  const lines = match[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i])
    if (!pair) continue
    let value = pair[2].trim()
    if (value === '' || /^[>|][+-]?$/.test(value)) {
      const block: string[] = []
      while (i + 1 < lines.length && /^\s+\S|^\s*$/.test(lines[i + 1])) block.push(lines[++i].trim())
      value = block.join(value.startsWith('|') ? '\n' : ' ').trim()
    }
    meta[pair[1]] = value.replace(/^(['"])([\s\S]*)\1$/, '$2')
  }
  return { meta, body: text.slice(match[0].length) }
}

// Home first, then each folder from the root down to the working directory; a nearer folder wins
async function scan($: EngineInterface): Promise<Map<string, Skill>> {
  const cwd = await $.session.cwd()
  if (cwd === scannedCwd) return skills
  const home = (await $.process.run(['/bin/sh', '-c', 'printf %s "$HOME"'])).stdout
  const parts = cwd.split('/').filter(Boolean)
  const roots = [home, ...parts.map((_, i) => '/' + parts.slice(0, i + 1).join('/'))]
  const native = new Set((await $.command.list()).filter(c => c.plugin !== 'agents-skills').map(c => c.name))
  const found = new Map<string, Skill>()
  for (const root of [...new Set(roots)]) {
    const base = `${root}/.agents/skills`
    if (!(await $.fs.exists(base))) continue
    for (const entry of await $.fs.list(base)) {
      if (entry.kind === 'file' || entry.name.startsWith('.')) continue
      const dir = `${base}/${entry.name}`
      const text = await $.fs.read(`${dir}/SKILL.md`).catch(() => undefined)
      if (typeof text !== 'string') continue
      const { meta, body } = parse(text)
      const name = meta.name || entry.name
      if (native.has(name)) continue
      found.set(name, { name, description: meta.description ?? '', dir, body })
    }
  }
  skills = found
  scannedCwd = cwd
  return found
}

function prompt(skill: Skill, args: string): string {
  const text = `Base directory for this skill: ${skill.dir}\n\n${skill.body.trim()}`
  return args ? `${text}\n\nARGUMENTS: ${args}` : text
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    scannedCwd = undefined
    for (const skill of (await scan($)).values()) {
      await $.command.register({ name: skill.name, description: skill.description.slice(0, 250) || skill.name })
    }
    return next(e)
  })

  // Add these skills to the listing the model reads beside the Skill tool
  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    const result = await next(e)
    const found = await scan($)
    if (result.text === null || found.size === 0) return result
    const lines = [...found.values()].map(s => `- ${s.name}: ${s.description}`)
    return { text: `${result.text}\n${lines.join('\n')}` }
  })

  // Answer the Skill tool for these skills, since the engine does not know them
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const input = e as unknown as { skill?: string; args?: string }
    const skill = input.skill ? (await scan($)).get(input.skill.replace(/^\//, '')) : undefined
    if (!skill) return next(e)
    return {
      result: { success: true, commandName: skill.name },
      context: [prompt(skill, input.args ?? '')],
    }
  })

  // `/name args` loads the skill and starts a turn with the arguments
  on('command.run', async ($, e, next) => {
    const skill = skills.get(e.command)
    if (!skill) return next(e)
    void $.prompt.submit({ text: e.args || `Use the ${skill.name} skill.`, asUser: true })
    return { text: `Loaded skill ${skill.name} from ${skill.dir}`, context: [prompt(skill, e.args)] }
  })
}
