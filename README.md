# claude-plugins

Claude Code plugins by jason301c.

## progress

A one-line progress band above the prompt. Claude sets it during large, multi-phase jobs with a percent, a state (working, needs you, failed, done) and a short text. It works in the terminal and in the desktop app's Code tab.

Install it from a terminal:

```bash
claude plugin marketplace add jason301c/claude-plugins
claude plugin install progress@jason301c
```

Or ask Claude: "Add the plugin marketplace jason301c/claude-plugins and install the progress plugin from it." Start a new session afterwards so the plugin loads.

The plugin uses function-hook modules, so it needs a recent Claude Code version. To get updates, run `claude plugin marketplace update jason301c`.
