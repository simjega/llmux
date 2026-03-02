# llmux

Multiplex LLM sessions in tmux. Manage a grid of named panes — each with a clear title and working directory — in a single tmux session.

## Install

```bash
# Make executable and symlink onto PATH
chmod +x llmux
ln -sf "$(pwd)/llmux" /usr/local/bin/llmux
```

## Usage

```bash
# Add named panes (tiles)
llmux add "auth-refactor" ~/code/myproject
llmux add "bug-hunt" ~/code/other
llmux add "quick-question"          # defaults to cwd

# Attach to the session
llmux attach

# List active panes
llmux ls

# Remove a pane when done
llmux rm "auth-refactor"
```

Panes auto-arrange in a tiled layout. Each pane's border shows its name and current directory.

## How it works

- A single tmux session (`llmux`) holds all panes in one window
- `add` creates a new split pane, titles it, and rebalances the tiled layout
- `rm` finds a pane by title and kills it, rebalancing afterward
- Pane borders display `name [directory]` so you always know what's what
