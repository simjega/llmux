---
name: developing-llmux
description: Use ALWAYS when modifying llmux source or working in ~/code/llmux. Captures llmux's architecture, conventions, metadata model, testing workflow, and the Owner-monorepo integration so changes stay coherent with the rest of the script. Load at session start.
---

# Developing llmux

You are working on **llmux**, a single-file bash tool that multiplexes LLM coding sessions inside one tmux session. This is Jay's day-to-day developer tool — bugs here block real work.

## Shape of the code

- `llmux` — one bash script, ~2200 lines, ~48 functions
- `llmux-watch` — sidekick daemon (~280 lines) that detects "Claude is waiting for you" and posts macOS notifications
- `README.md` — user-facing intro
- Symlinked to `~/.local/bin/llmux`

There's **no formal test suite**. You verify changes by:
1. `bash -n llmux` (syntax check — do this after every edit)
2. Manually running the commands inside an actual llmux session
3. Reading the diff carefully — small surface, easy to inspect

## Mental model

**One tmux session** named `llmux` with named panes. Pane metadata lives in tmux **user options** (no separate state file), so they survive across tool restarts:

| Option | Meaning |
|---|---|
| `@llmux_name` | Pane's logical name (survives tool title overwrites) |
| `@llmux_tool` | Which LLM CLI is running here (`claude`/`amp`/`codex`/...) |
| `@llmux_terminal` | "1" if this is the always-on shell pane |
| `@llmux_pinned` | "1" if this is the always-visible top-right pane (e.g. `make-llmux-better`) |
| `@llmux_worktree` | Branch name if this pane is on a git worktree |
| `@llmux_slot` | `slot-N` if pane adopted an `owner-wt` slot |
| `@llmux_status` | `working` / `waiting` — set by `llmux-watch` |
| `@llmux_claude_session` | Claude session UUID, set asynchronously after launch |

**Never size sidebar text from `SIDEBAR_WIDTH`.** That constant is only the width the
pane is *created* at. `render_sidebar` measures `#{pane_width}` into `sb_w` each paint
and every label budget derives from that, so a resize shows more text rather than
staying cut at the old width; it also records the live width into
`@llmux_sidebar_width`, which `sidebar_apply_layout` restores instead of the constant
(it used to snap the pane back to 30 on every switch). Budgets must account for a
status emoji as **3 columns** (2 for the glyph + its space) — unbudgeted it only ever
fit because names were capped at 18. The render also sets `\033[?7l` (autowrap off):
overflow then smears the last cell instead of wrapping, which keeps `rowmap` aligned —
a wrapped row would silently misroute every click below it. A width change between
paints can smear briefly; the next repaint clears it.

**`paused.json` is an OBJECT now, not a list.** It was `[{pane}, ...]`; it is
`{"paused": [...], "prs": [...]}`. Every access goes through the `PY_PAUSED_IO`
`_load`/`_save` pair — `_load` accepts both shapes so an older file still reads, and
`_save` always writes the object, migrating in place on first write. **Never
`json.load()` the file directly**: on a list-form file every `.get("prs")` breaks, and
the first save silently drops every paused thread. `_save` is temp-file + rename
because the watcher's PR refresher and an interactive pause can collide.

**Registered PRs** split across the two stores on purpose: *intent* (which PRs, whose
project, agent-given title and stack name) persists in `paused.json`; *fetched* state
(open/draft/last-activity) is the disposable `@llmux_prs_state` tmux option, refreshed
by `llmux-watch` every ~24 cycles. Losing the cache costs one refresh. Stack toggle ids
are md5-hashed, not `project/title` — both `prmap` and `@llmux_pr_expanded` are
comma-separated and PR titles contain commas.

**Paused panes** are the one piece of persisted state — they live in `~/.config/llmux/paused.json`. A paused pane is invisible to tmux but remembers its dir, tool, worktree, slot, etc. Resuming a paused pane recreates it.

**Layout** (`apply_layout`, line 343):
- Terminal pane top-left, pinned pane top-right (if any), LLM panes tiled below
- `main-horizontal` layout for the LLM tiles
- Always re-run after add/rm/cycle so the layout settles

## Subcommand pattern

Every subcommand is `cmd_<verb>()` and gets dispatched in the case statement near the end of the file. To add a new subcommand:

1. Write `cmd_yourverb()` somewhere reasonable in the file (group with related cmds)
2. Add `yourverb)  cmd_yourverb "$@" ;;` to the dispatch case
3. Add a `usage` line near the top
4. Run `bash -n llmux`

## Tool-specific quirks (don't forget these)

- **Claude** — pass `-n <name>` at launch to set the session display name (cleaner than the old `/rename` send-keys hack). Session UUID is captured async by `capture_claude_session_async` after the jsonl appears in `~/.claude/projects/`.
- **Amp** — needs a `THREAD_ID` from `amp threads new`, then `amp threads rename`, then `amp threads continue`. See `launch_tool_in_pane`.
- **Codex** — `codex resume --last` to continue, `codex resume <id>` to pick a specific session. The old `--full-auto` was removed in 0.130+; the modern equivalent is `--dangerously-bypass-approvals-and-sandbox` (matches Claude's `--dangerously-skip-permissions` trust level).
- **Pinned panes** are launched via `launch_tool_in_pane "$pinned_pane" "${LLMUX_PINNED_TOOL:-}" "$pinned_name"`. They CAN be cycled (`cmd_cycle` preserves `@llmux_pinned`).

## Resume harvesters

Three of them, in `harvest_<tool>_sessions`:
- **Claude** — Python script that scans `~/.claude/projects/<encoded-cwd>/*.jsonl` for the first user message and timestamp.
- **Amp** — shells out to `amp threads search --json`.
- **Codex** — sqlite query against `~/.codex/state_5.sqlite` (`threads` table). Newer codex versions might rename this; check before assuming.

Other supported tools (aider, sgpt, llm, mods, ollama) are add-only — no resume.

## Owner monorepo integration

Inside `~/owner/Owner`, llmux delegates worktree slot management to **`owner-wt`**. The contract:

- `llmux add <pane> --slot[=slot-N]` adopts an idle `owner-wt` slot. With no `slot-N` and >1 idle, gum picker. New branch defaults to pane name; `--branch X` overrides. 0 idle → error.
- `llmux pause` / `llmux rm` dirty-check the slot first (`git status --porcelain` + untracked file scan). Dirty → refuse with "commit/stash or `--force`". Clean → `owner-wt release` so the slot returns to idle.
- `llmux resume` of a paused worktree-pane re-grabs its branch into any idle slot (not necessarily the original).
- Source of truth for "who owns which slot" is **derived**, not stored: active panes carry `@llmux_slot`; paused panes carry it in `paused.json`. `owner-wt ls` cross-references both.
- Outside `~/owner/Owner`, `--slot` is a no-op and the worktree flow falls back to `git worktree add` under `.worktrees/` or `.workspaces/`.

`owner-wt` errors loudly when run outside `~/owner/Owner`. If you see `[owner-wt] ERROR: owner-wt must run from ...` in test output, that's the cwd check firing, not a bug.

## Conventions

- **Bash, not POSIX sh.** `[[ ]]`, `read -r`, arrays, `local` — fine to use.
- **Defensive guards everywhere** before tmux/gum/owner-wt calls. Return non-zero with a clear `echo "Error: ..." >&2` rather than crashing.
- **Quote everything that could have spaces.** Pane names and dir paths often do.
- **No new state files** if you can derive the same info from tmux options + `paused.json`. The whole design depends on this.
- **`--force` is the escape hatch** for dirty-slot guards. Don't add new guards without a corresponding `--force` path.
- **Pinned-pane guards have been removed from `cmd_cycle`**. Pin state is preserved through the cycle by capturing `@llmux_pinned` and re-setting it on the new pane before `apply_layout`. If you add new pin guards, do the same.
- **`llmux refresh` is a heavy hammer** — it recreates the session, resumes tools, and drops idle panes. Don't expand its scope without thinking through what survives.

## When making changes

1. **Read the affected `cmd_*` function in full** before editing — many of them share helpers (`launch_tool_in_pane`, `resume_tool_in_pane`, `apply_layout`, `slot_dirty_check`, `release_slot`).
2. **Check the dispatch case** at the bottom — if you rename a helper, make sure nothing downstream still expects the old name.
3. **`bash -n llmux`** after each edit. Catches every typo.
4. **Update the README and the skill files** when you add a new subcommand or change a flag default. The skill files are at:
   - `~/.claude/skills/llmux/SKILL.md` (Claude's view of llmux)
   - `~/.codex/skills/llmux/SKILL.md` (Codex's view)
   - Both should stay in sync.
5. **Commit messages are conventional-ish** (`feat:`, `fix:`, `style:`). Look at `git log --oneline -20` for the prevailing tone.

## Things that have surprised past Claude sessions

- The harvester for codex uses `state_5.sqlite` — if codex bumps its sqlite version, the file name changes and the harvester silently returns empty. Test with `sqlite3 ~/.codex/state_5.sqlite "SELECT id, cwd FROM threads ORDER BY updated_at DESC LIMIT 3"` if codex sessions stop showing up.
- nodenv per-directory Node versions can hide globally-installed tools (codex, etc.). When the user reports "command not found in this pane," check `~/<some-repo>/.node-version` vs which versions have the tool installed.
- The pinned pane is **not** automatically recreated by `cmd_refresh` if you `kill-pane` it manually — only `ensure_session` creates it, and that only runs when there's no session at all. `cmd_cycle make-llmux-better` is the supported way to restart it.
- **Sidebar clicks must resolve against `@llmux_sidebar_rowmap`, not a fresh `list_threads`.** The renderer and the click handler used to each recompute `list_threads` and trust them equal; they diverge the instant the displayed order goes stale (a `llmux top` lands, or the render loop is mid-cycle), so a click selected a *different* thread than the row shown. `render_sidebar` now publishes the pane ids it drew, in draw order, to `@llmux_sidebar_rowmap` **in the same call that paints the pixels**; `sidebar_click` indexes that map and switches by pane id. Whatever draws a row must publish that row's identity atomically with the pixels.
- **Only one `_sidebar-loop` may paint at a time.** Two loops repaint every 2s from independent reads, so one writes pixels for order A while the other publishes a rowmap for order B → clicks miss intermittently (this bit hard, and an orphan wrapper left by a pane swap is the usual cause). The loop is wrapped in `while :; do llmux _sidebar-loop || break; sleep 1; done` (revives on exit) and claims `@llmux_sidebar_loop_pid` (newest wins); a superseded loop returns non-zero and the `|| break` retires it. Diagnose a "row selection broken" report with `ps ax | grep _sidebar-loop` **first** — a second process means state, not code, is wrong.
- **`RETURN` traps in click-path helpers must self-clear.** A bash `RETURN` trap is not function-local; left installed it re-fires when the caller returns, where the trap's locals are out of scope → `set -u` "unbound variable" → the handler exits 1 → tmux spams `'llmux _click …' returned 1` into the pane. `cmd_switch`'s lock trap guards `${lock:-}` and does `trap - RETURN` as it fires. Mirror that in any new `RETURN` trap a click path touches.
- **`cmd_cycle` resolves the target with `list-panes -s`** (all windows), not the active window only — `cycle all` toggles the sidebar off (scattering panes) before cycling, and the old active-window-only lookup then failed to find them.
