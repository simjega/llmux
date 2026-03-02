# llmux

Multiplex LLM sessions in tmux. Manage a grid of named panes — each with a clear title and working directory — in a single tmux session.

## Install

```bash
git clone https://github.com/simjega/llmux.git
cd llmux
chmod +x llmux

# Symlink onto PATH (pick one)
ln -sf "$(pwd)/llmux" ~/.local/bin/llmux    # if ~/.local/bin is on PATH
ln -sf "$(pwd)/llmux" /usr/local/bin/llmux  # system-wide
```

## Quick start

```bash
# 1. Configure your LLM tool
llmux setup

# 2. Add sessions
llmux add "auth-refactor" ~/code/myproject
llmux add "bug-hunt" ~/code/other

# 3. Attach and start working
llmux attach
```

## Commands

### `llmux setup`

Scans your machine for known LLM CLI tools (`amp`, `claude`, `aider`, `sgpt`, `llm`, `mods`, `ollama`), shows which ones are installed, and lets you pick a default. Also prompts for startup args (e.g. `--dangerously-skip-permissions` for Claude Code).

Config is saved to `~/.config/llmux/config`.

### `llmux add <name> [directory]`

Create a new pane titled `<name>`. Optionally specify a working directory (defaults to cwd). Automatically launches the configured LLM tool.

```bash
llmux add "feature-work" ~/code/myproject
llmux add "quick-question"
```

### `llmux resume [name]`

Harvest past sessions from your configured tool and pick one to resume in a new pane. Supports **Claude Code** (scans `~/.claude/projects/`) and **Amp** (`amp threads list`).

Shows a numbered list with timestamps, first user message, session ID, and project directory. The pane auto-titles from the session summary, or pass a custom name.

```bash
llmux resume                  # interactive picker
llmux resume "my-label"       # resume with a custom pane name
```

This is how you "move" a session from a regular terminal into llmux — just resume it.

### `llmux grab <name> [source-pane]`

Move an existing tmux pane into the llmux session. Without a source, shows an interactive picker of all non-llmux panes. The running process is preserved.

```bash
llmux grab "ongoing-debug"                  # interactive picker
llmux grab "my-session" othersession:0.1    # grab a specific pane
```

### `llmux rm <name>`

Remove a pane by name. If it's the last pane, the session ends.

```bash
llmux rm "auth-refactor"
```

### `llmux ls`

List all active panes with their index, name, and working directory.

### `llmux attach`

Attach to the llmux tmux session. If already inside tmux, switches the client.

### `llmux help`

Show usage summary.

## How it works

- A single tmux session (`llmux`) holds all panes in one window
- Panes auto-arrange in a tiled grid layout as you add/remove them
- Pane borders display `name [directory]` so you always know what each session is doing
- The configured LLM tool launches automatically in new panes
- `resume` harvests past sessions from the tool's local storage, letting you pick up where you left off — even from sessions started outside llmux
