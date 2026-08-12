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
- **`@llmux_status` has exactly one writer: `llmux-watch`.** It recomputes every pane's status every 5s, so anything else writing that option is erased within a cycle — which is why "the thread is asking Jay something" is a SEPARATE pane option, `@llmux_asking`, that the watcher reads and promotes to `blocked` (below `perm`, never overriding a menu it detected). Set by `~/.agents/hooks/llmux-asking.sh` on Claude's Notification/Stop/UserPromptSubmit events, and by `llmux asking` for tools with no hooks. The first real output after Jay answers clears it, so a forgotten flag cannot pin a row red. The Stop hook tests only the LAST line of the final assistant message: a "?" earlier is usually the agent quoting a question it just answered, and over ~2,600 real messages that rule flags 3%.
- **Thread-to-thread messages are delivered by `send-keys` into the target PANE, never by resuming its session.** `claude --resume <id> -p` looks like the right API and is a trap: a live TUI already holds that transcript open, so a second writer corrupts the session instead of delivering anything. The recorded session id (`@llmux_claude_session` / `@llmux_opencode_session`) is for NAMING a thread, not for talking to it. Two guards are load-bearing: a pane on a permission gate or a choice menu reads keystrokes as answers, so `send` refuses those states (a menu selection made by a stray message is unrecoverable), and the payload carries its own attribution because the recipient may have no llmux context and a peer message must not read as Jay speaking.

- **Looking is not answering.** `mark_thread_seen` retires the done/unseen dot only. An asked-in-prose `@llmux_asking` flag remains visible in the sidebar and pane border until real conversation output resumes after Jay's answer. The watcher copies the opaque ask generation to `@llmux_asking_armed` when it first displays the block, then only matching-generation output may clear it; this prevents the question's own output or a rapid follow-up question from erasing the marker. Permission gates and unanswered menus likewise remain marked until resolved.
- **`llmux-watch` honours `LLMUX_SESSION`** (state dir and pidfile take a `-<session>` suffix for anything but the default) — before that it hardcoded `SESSION="llmux"` and a shared `/tmp/llmux-watch.pid`, so there was no way to test a watcher change except against Jay's live session, and a second copy clobbered the pidfile that `_watch-stop` kills by.

- **A Forge task is a LINK, never a thread — resist the obvious modelling.** It is very nearly a thread (an agent working the same project, just online rather than in a pane), and that resemblance is the trap: a thread in llmux *is* a tmux pane, and `cmd_switch`, `park_pane`, `cmd_cycle`, `resume_tool_in_pane`, `snapshot_session` and `apply_layout` all act on a pane id they assume exists. A pseudo-thread with no pane behind it breaks every one of them. It renders as one row per task directly above the threads — it shared the links row with `(Monitor)` and the flags first, and that row cannot carry a project with a monitor, two flags and two tasks; the overflow silently drops whatever comes last. Stored in `paused.json` under `"forge"` as a list per project (same shape as flags, for the same reason: a project can have several). The `⚒` glyph is U+2692, which is Neutral width — ONE column. That is load-bearing: the links row computes hotspot columns with `${#label}` character counts, so a two-column glyph shifts every hotspot after it off its own text.

- **The review queue belongs to `reviewq`, not to llmux.** `llmux review` shells out to the `reviewq` CLI for every mutation and only ever READS `~/.config/reviewq/queue.jsonl`; two writers on one jsonl is how an entry gets lost, and Jay drains the same queue with `reviewq review`. The one thing llmux persists is routing — `paused.json` `"reviews": {"<id>": "<project>"}` — because reviewq's `--project` defaults to the cwd basename and matches no sidebar section. An entry matching no section is filed under SCRATCH rather than dropped: a doc an agent queued and nobody can see is worse than one in the wrong place. The rows are cached like the PR rows (one python3 start per rebuild) but on an HOUR bucket, since the only time-dependent decision is aging out a doc approved over `LLMUX_REVIEW_KEEP_HOURS` ago. The cache signature includes the queue file's SIZE as well as its mtime, because Jay resolves entries through reviewq — which llmux never sees — and `stat` mtime is only second-resolution.

- **The sidebar pane must not accumulate scrollback, and must not scroll.** tmux files a `\033[2J`-erased frame into the pane's history — that is what makes a shell's `clear` still scrollable — so a pane repainted every 2s reaches `history-limit` within the hour, full of stale copies of itself. Scrolling up then shows a frame of dead rows that is indistinguishable from live state (Jay hit exactly this). The paint ends with `\033[3J` to drop the history, and `sidebar_bind_mouse` binds `WheelUpPane` to swallow the wheel over `@llmux_sidebar=1` panes. That binding's else arm has to reproduce tmux's stock behaviour verbatim, because key bindings live in the server and apply to every session on it, not just llmux's.

- **Sidebar clicks must resolve against `@llmux_sidebar_rowmap`, not a fresh `list_threads`.** The renderer and the click handler used to each recompute `list_threads` and trust them equal; they diverge the instant the displayed order goes stale (a `llmux top` lands, or the render loop is mid-cycle), so a click selected a *different* thread than the row shown. `render_sidebar` now publishes the pane ids it drew, in draw order, to `@llmux_sidebar_rowmap` **in the same call that paints the pixels**; `sidebar_click` indexes that map and switches by pane id. Whatever draws a row must publish that row's identity atomically with the pixels.
- **Only one `_sidebar-loop` may paint at a time.** Two loops repaint every 2s from independent reads, so one writes pixels for order A while the other publishes a rowmap for order B → clicks miss intermittently (this bit hard, and an orphan wrapper left by a pane swap is the usual cause). The loop is wrapped in `while :; do llmux _sidebar-loop || break; sleep 1; done` (revives on exit) and claims `@llmux_sidebar_loop_pid` (newest wins); a superseded loop returns non-zero and the `|| break` retires it. Diagnose a "row selection broken" report with `ps ax | grep _sidebar-loop` **first** — a second process means state, not code, is wrong.
- **`RETURN` traps in click-path helpers must self-clear.** A bash `RETURN` trap is not function-local; left installed it re-fires when the caller returns, where the trap's locals are out of scope → `set -u` "unbound variable" → the handler exits 1 → tmux spams `'llmux _click …' returned 1` into the pane. `cmd_switch`'s lock trap guards `${lock:-}` and does `trap - RETURN` as it fires. Mirror that in any new `RETURN` trap a click path touches.
- **`cmd_cycle` resolves the target with `list-panes -s`** (all windows), not the active window only — `cycle all` toggles the sidebar off (scattering panes) before cycling, and the old active-window-only lookup then failed to find them.
