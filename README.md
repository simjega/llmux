# llmux

Multiplex LLM sessions in tmux. Manage a grid of named panes — each with a clear title and working directory — in a single tmux session.

## Install

```bash
git clone https://github.com/simjega/llmux.git
cd llmux
chmod +x llmux

# Symlink onto PATH
ln -sf "$(pwd)/llmux" ~/.local/bin/llmux

# Install dependencies & configure
llmux setup
```

`setup` installs `gum`, `tmux`, and `python3` via Homebrew if missing, then walks you through picking your LLM tool and any startup args.

## Quick start

```bash
llmux setup                              # one-time: install deps + pick tool
llmux add "auth-refactor" ~/code/project  # open a named session
llmux add "bug-hunt"                      # another (defaults to cwd)
llmux attach                              # jump in
```

## Commands

| Command | Description |
|---------|-------------|
| `llmux setup` | Install dependencies and configure your LLM tool |
| `llmux add <name> [dir]` | Create a new named pane, launch configured tool |
| `llmux resume [name]` | Browse & resume a past session in a new pane |
| `llmux grab <name> [pane]` | Move an existing tmux pane into llmux |
| `llmux rm <name>` | Remove a pane by name |
| `llmux ls` | List active panes |
| `llmux attach` | Attach to the llmux session |

### `llmux setup`

Installs dependencies (`gum`, `tmux`, `python3`) via Homebrew, then lets you pick a default LLM CLI from what's on your machine (`amp`, `claude`, `aider`, `sgpt`, `llm`, `mods`, `ollama`) and set startup args (e.g. `--dangerously-skip-permissions`).

Config saved to `~/.config/llmux/config`.

### `llmux add <name> [directory]`

Create a new pane titled `<name>`, optionally in a specific directory. Automatically launches the configured LLM tool.

### `llmux resume [name]`

Harvest past sessions from your configured tool and pick one to resume via a fuzzy-searchable picker (powered by `gum`). Sessions show relative timestamps, the first user message, and the project directory in color.

Supports **Claude Code** (scans `~/.claude/projects/`) and **Amp** (`amp threads list`).

This is how you "move" a session from a regular terminal into llmux — just resume it.

### `llmux grab <name> [pane]`

Move an existing tmux pane into the llmux session. Without a source, shows a fuzzy picker of all non-llmux panes. The running process is preserved.

### `llmux rm <name>`

Remove a pane by name. If it's the last pane, the session ends.

## Dependencies

All installed automatically by `llmux setup`:

- **[gum](https://github.com/charmbracelet/gum)** — beautiful terminal UI for pickers and prompts
- **tmux** — terminal multiplexer
- **python3** — used for harvesting Claude Code session history

## How it works

- A single tmux session (`llmux`) holds all panes in one window
- Panes auto-arrange in a tiled grid layout as you add/remove them
- Pane borders display `name [directory]` so you always know what each session is doing
- The configured LLM tool launches automatically in new panes
- `resume` harvests past sessions from the tool's local storage, letting you pick up where you left off — even from sessions started outside llmux
