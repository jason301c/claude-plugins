# claude-plugins

Claude Code plugins by jason301c.

Add the marketplace once, then install the plugins you want:

```bash
claude plugin marketplace add jasons-work-projects/claude-plugins
claude plugin install progress@jason301c
```

Or ask Claude: "Add the plugin marketplace jasons-work-projects/claude-plugins and install the progress plugin from it." Start a new session afterwards so the plugin loads.

The plugins use function-hook modules, so they need a recent Claude Code version. To get updates, run `claude plugin marketplace update jason301c`.

## progress

A one-line progress band above the prompt. Claude sets it during large, multi-phase jobs with a percent, a state (working, needs you, failed, done) and a short text. It works in the terminal and in the desktop app's Code tab.

## images

A `generate_image` tool that makes or edits images with GPT Image 2.5 Flare through OpenRouter. Each call is one paid request on your OpenRouter account. The tool saves each image to `~/Pictures/claude-images` unless you set another folder.

Set your OpenRouter API key with `claude plugin configure images@jason301c`. The desktop app does not pass that setting to the plugin, so for the desktop app put the key in `~/.config/claude-images/.env`:

```
OPENROUTER_API_KEY=sk-or-...
```

## statusline

A status line with the number of connected MCP servers, this session's spend at API list prices, and a countdown to when the prompt cache expires. It needs Node.

The plugin also writes these figures to `~/.cache/claude-statusline-<session id>.json`. If your own `statusLine` command reads that file and draws the figures, turn on the `terminalScript` option. The plugin then shows no line of its own in a terminal.

## agents-skills

Loads skills from `.agents/skills` folders as Claude Code skills. It looks in your home folder and in every folder from the root down to the working directory. A nearer folder wins over a farther one, and a Claude Code skill with the same name wins over both.
