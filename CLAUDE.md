# llmux (project)

Before any code change in this repo, invoke the `developing-llmux` skill from `.claude/skills/developing-llmux/SKILL.md`. It captures the architecture, metadata model, tool-specific quirks, Owner-monorepo integration, and the "things that have surprised past Claude sessions" list — every one of which has bitten a previous session.

This is the **make-llmux-better** pinned pane. It's Jay's daily-driver dev tool, so:
- `bash -n llmux` after every edit (no test suite — syntax check is your first line of defense).
- Don't add new state files. Use tmux user options (`@llmux_*`) or `paused.json`.
- Keep `~/.claude/skills/llmux/SKILL.md` and `~/.codex/skills/llmux/SKILL.md` in sync with any user-facing behavior change.
