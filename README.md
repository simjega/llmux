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
| `llmux add <name> --tool forge --task <tsk-id>` | Open a Forge task as a managed llmux thread |
| `llmux resume [--tool <tool>] [--all]` | Browse & resume a past session in a new pane (picker only — it takes no name) |
| `llmux grab <name> [pane]` | Move an existing tmux pane into llmux |
| `llmux cycle [name]` | Restart a pane's tool in place, resuming the same session |
| `llmux cycle all` | Cycle every pane (terminal excepted); rebuilds the sidebar in sidebar mode |
| `llmux rm <name>` | Remove a pane by name |
| `llmux ls` | List active panes |
| `llmux attach` | Attach to the llmux session |
| `llmux sidebar [on\|off]` | Toggle the thread-list UI (sidebar column, one thread visible at a time) |
| `llmux switch [name\|index]` | Make a thread the visible one (no argument = picker) |
| `llmux mv [name\|index] [project]` | Move a thread — live or paused — to another project (missing args are prompted for) |
| `llmux project [ls\|new\|link\|unlink\|open]` | Tie a project to the Tolaria notes that hold its memory |
| `llmux next` / `llmux prev` | Step to the next/previous thread (wraps) |
| `llmux top <name>...` | Move threads to the top of their sidebar section, in the order given |

### Sidebar mode (thread list)

`llmux sidebar on` re-arranges the session into a narrow thread list on the left and
one full-size thread to its right:

```
┌──────────────────────────────┬────────────────────┐
│ llmux threads         🙋1    │                    │
│ ────────────────────────    +│                    │
│ SCRATCH ─────────────────────│                    │
│  1 ❯ terminal                │                    │
│  2 ✳ quick-question          │                    │
│                              │  active thread     │
│ LLMUX ───────────────────────│   (full size)      │
│ ▶3 ✳ make-llmux-better       │                    │
│  4 ◇ codex-dump              │                    │
│    ↳ inspect_state · Nash    │                    │
│    ↳ render_seam · Maxwell   │                    │
│                              │                    │
│ OWNER ───────────────────────│                    │
│ ·5 ✳ vip-last-mile        🙋 │                    │
│  6 ✳ cc-zeus                 │                    │
│  7 ❯ owner-dev               │                    │
└──────────────────────────────┴────────────────────┘
```

The list shows each thread's number and a status flag when `llmux-watch` has something
to tell you about it.

Codex sub-agents that are running appear as indented `↳` rows beneath their parent
thread. The task name is always shown; widening the sidebar also reveals the Codex
nickname when it fits. These rows are live status, not threads: they appear within one
watcher tick (about five seconds), disappear after completion or interruption, and are
intentionally inert when clicked because no tmux pane exists behind them.

llmux also schedules an Owner slot-cleanup thread every 24 hours. It runs from the
base Owner checkout without claiming a slot, reuses the existing `slot-cleanup`
thread after it finishes, and follows the guarded `slot-cleanup` skill: only clean,
unclaimed work with a finished PR is eligible. Active, recent, dirty, open-PR, and
no-PR slots are held for review. Use `llmux slot-cleanup status` to inspect the
schedule or `llmux slot-cleanup now` to kick it off immediately. Set
`LLMUX_SLOT_CLEANUP_HOURS=0` in the watcher environment to disable it.

**Status flags. A flag means "look at this" — so most threads carry none:**

| flag | state | means |
|---|---|---|
| 🙋 | `blocked` | a question or choice is waiting on **you** |
| 🔐 | `perm` | a permission / approval gate |
| 🌀 | `busy` | working 2+ minutes, needs nothing |
| *(none)* | `idle` | turn finished, sitting at the prompt |

**`idle` is deliberately unmarked.** It's the resting state of every thread that isn't
doing something right now, so at any moment most of the list is idle — marking it made 💤
the most common glyph in the column, which is exactly backwards. An unmarked row means
"fine, nothing wanted", and the status-bar tally is empty when nothing needs you.

### Ongoing PRs, per project

Each project section also lists the PRs that work has produced, below its threads.
Agents register them as they open them (`llmux pr add <number|url>`), so the list is
whatever is actually in flight rather than every PR you've ever authored.

```
 custom-campaigns-me2 ──
  1 ✳ cc-zeus
  ⌥ test-send slug    ▾4     ← a stack: one row, click to expand
    ⌥ #52093 read flag
    ⌥ #52094 detail routing
    ⌥ #52095 test-send slug
    ⌥ #52096 hermes slug
 location-scoped-footer ─
  2 ✳ footer-work
  ⌥ #53625 footer addresses  ← click opens it in a browser
```

- **Drag the divider to read more.** Every label — thread names, PR titles, stack
  names — is cut to what the pane can actually show at its current width, never to a
  fixed cap, so widening the sidebar reveals more text on the next repaint (≤2s). The
  width you leave it at is remembered (`@llmux_sidebar_width`) and restored, instead of
  snapping back to the 30-column default on the next thread switch.
- **Clicking a PR row opens it in Graphite** (`app.graphite.dev/github/pr/<repo>/<n>`) —
  where a stack is reviewable *as* a stack, which a GitHub PR page can't show. Clicking
  a stack row expands or collapses it. Set `LLMUX_PR_LINK=github` for a repo whose org
  isn't on Graphite, where that URL would 404.
- **Stacks group two ways.** An agent passing `--stack "<name>"` names the group
  itself. Failing that, llmux infers the chain from base/head branches — a `gt` stack
  groups itself, titled after its bottom PR.
- **The list self-curates.** A PR drops off once it merges, closes, or goes quiet for
  14 days (`LLMUX_PR_STALE_DAYS`). It stays registered; only the row disappears, so
  nothing has to be pruned by hand.
- **Registration is persisted** in `paused.json` (which is now
  `{"paused": [...], "prs": [...]}` — a bare list from an older llmux still reads).
  Fetched state — open/draft/last-activity — is a disposable tmux option refreshed by
  `llmux-watch` every ~2 min, never a file.

### Forge sessions

Forge tasks can run as real llmux threads. llmux uses the installed OwnerForge CLI
to discover owned tasks, start or resume their remote workspaces, and attach the
remote OpenCode terminal over SSH:

```bash
llmux resume --tool forge
llmux add marketing-pages --tool forge --task tsk-PJhst1k2tEhU --project lilo
```

The sidebar `+` includes Forge when the CLI is installed; choosing it opens the task
picker. A running Forge thread carries the task id in `@llmux_forge_task`, so
`pause`, `resume`, `cycle`, `refresh`, `snapshot`, and crash restore all reopen the
same remote task. It gets its own Forge glyph and otherwise behaves like any local
llmux thread. One task can be claimed by only one live or paused llmux pane. Because
the actual checkout is remote, Forge panes always use `$HOME` as their neutral local
cwd and reject local `--slot`, `--worktree`, and `--branch` options.

`llmux send` cannot yet prove that the remote OpenCode UI is at a safe input prompt,
so ordinary peer delivery to Forge is refused. Inspect the pane and use `--force`
only when you have confirmed it is not showing a permission gate or choice menu.

### Forge task links, per project

A Forge task can also be tracked without opening a terminal. Attach it as a link and it gets
**a row of its own**, directly above the threads:

```
 custom-campaigns-me2 ──
  (Monitor) customCampaignsMe2 customCampaignsMe2Read
  👀 Rollout sequencing
  ⚒ shadow parity sweep      ← click opens the task in Forge
  ⚒ flaky test hunt
 1 ✳ cc-last-mile
```

They shared the links row at first and that row could not carry them: a project with a
monitor, two flags and two tasks ran off the right edge, and whatever came last was
what fell off. A task also has a human-written name that wants room, unlike a flag
whose label is a fixed identifier.

Last before the threads on purpose — a linked Forge task is the same axis as a thread
(work in progress, one line each), so the two read as one list, with unopened tasks
sitting just above the terminal sessions llmux can switch to.

```bash
llmux project forge custom-campaigns-me2 tsk-CJyj5XHDU6Pz shadow parity sweep
llmux project forge custom-campaigns-me2 https://forge.owner.sh/tasks/tsk-CJyj5XHDU6Pz
llmux project forge custom-campaigns-me2 --remove tsk-CJyj5XHDU6Pz
llmux project forge                      # list them all
```

- **A link until you open it.** `llmux project forge` is tracking-only: one click opens
  the task in a browser, and no tmux pane exists behind the row. Use `llmux resume
  --tool forge` or `llmux add … --tool forge --task …` when you want an interactive
  terminal that llmux can switch, pause, cycle, and restore.
- **A bare `tsk-…` id is enough** — it expands to `forge.owner.sh/tasks/<id>`, which is
  what you have to hand the moment an agent spawns one. A full URL works too.
- **Name it for the work, not for the task.** The trailing words become the row's
  label (`⚒ shadow parity sweep`). Not the task id, and not Forge's own generated task
  name either — that is written from the prompt and arrives long and literal. The ⚒ and
  its colour already say "this is Forge"; the label is free to spend every column on
  *which* piece of work it is. Register one without a name and it says `⚒ untitled
  task`, plus a warning on the way in.
- **Every Forge row is the same colour, in every project** — deliberately not the
  project colour that `(Monitor)` and the flags take. A running task is a different
  kind of thing from the links above it and the threads below it, and the row says so
  before you have read a word of it.
- **A project with a task still running keeps its section**, even after its last local
  thread ends. A Forge task outliving every pane is the normal case, not an odd one.
- **A project can carry several.** Re-registering the same task updates its title
  rather than duplicating; `--remove` takes the bare id or the full URL, `--clear`
  drops them all. Nothing expires them — a finished task stays until you remove it.

### Docs waiting on you, per project

A thread that produces something you need to read — a plan, a recap, a decision
write-up — queues it, and it draws at the **top** of its project, above the threads.
A doc awaiting sign-off is usually what the work under it is waiting on, which is the
inverse of PR rows: those record what already shipped, so they sit at the bottom.

```
 custom-campaigns-me2 ──
  (Monitor) customCampaignsMe2
  👀 Rollout sequencing        ← needs your eyes; click opens the doc
  👀 SLO thresholds
     Zeus cutover checklist    ← you signed off; emoji gone, row fades out
  1 ✳ cc-zeus
  ⌥ #52093 read flag
```

- **👀 is the whole signal.** It means "this wants your eyes". Approve the entry and
  the emoji goes; the row stays a plain link for `LLMUX_REVIEW_KEEP_HOURS` (24, set 0
  to drop it immediately) so "what did I just approve" is still on screen.
- **It rides on [`reviewq`](~/.local/bin/reviewq), not a second queue.** llmux reads
  `~/.config/reviewq/queue.jsonl` and never writes it, so `reviewq review` still drains
  the same entries and clearing one there clears the 👀 here within a repaint.
- **`llmux review add` exists to get the project right.** `reviewq` defaults its
  `--project` to the basename of the cwd, which in a worktree is a repo name, not the
  work — entries land under `Owner` or `jay` and match no section. Called from a
  thread, `llmux review add` fills in *that thread's* project, the way `pr add` does.
- **Nothing queued is ever invisible.** An entry whose project matches no section is
  filed under SCRATCH rather than dropped, and a project with a doc still pending is
  drawn even after its last thread ends. `llmux review mv <id> <project>` re-files one
  (stored in `paused.json`, so reviewq's own file stays reviewq's).

```bash
llmux review add --title "Rollout sequencing" --url <lookout-url> \
                 --kind plan --context "Which ramp order do you want?"
llmux review ls                  # id, project, state, title
llmux review done 7              # signed off — clears the 👀
llmux review mv 2 custom-campaigns-me2
```

### A new thread reads itself in before it starts

```bash
llmux context
```

Prints what llmux already knows about the thread's project — the vault notes with
exact paths in reading order, the monitor/flag/Forge links, the PRs registered under
it, the docs still waiting on Jay, the sibling threads working the same project, and
the repo's CLAUDE.md/branch. The SessionStart hook tells every new agent to run it
**and read what it points at before accepting any instruction**, then say back where
the project stands.

It points rather than dumps. A wall of file contents in every session is a tax on
every trivial one; a list of exact paths costs a few lines and the agent reads what
its task actually needs.

The failure it exists to stop: an agent dropped into ongoing work, acting before it
knows that another thread already owns the piece, that the decision was settled a
week ago in the decision log, or that a doc answering the question is sitting in the
review queue.

### Threads can message each other

```bash
llmux who                                    # the directory: who exists, and how busy
llmux send cc-last-mile "the reads flag is live in staging — retest?"
```

`who` lists every live thread with its name, project, tool, **status**, session id and
cwd; `--json` for agents. `send` resolves a target by exact name, session id, or
unique name prefix — anything ambiguous is an error rather than a guess, because
delivering to the wrong agent is worse than not delivering.

- **Delivery goes through the pane, not `claude --resume <id> -p`.** The session id is
  the right way to *name* a thread and llmux already records it per pane, but resuming
  a session a live TUI is holding open puts two writers on one transcript: that
  corrupts the session instead of delivering a message. The pane is where a running
  agent actually reads input, so that is the mailbox.
- **It refuses to type into a prompt.** A pane sitting on a permission gate or a
  choice menu reads keystrokes as *answers* — a message would approve a tool call
  nobody vetted, or pick an option. Those states are refused (`--force` if you know
  better). A thread that stopped to ask a *question* is fair game: a message is the
  answer.
- **Messages are attributed in the payload**, not by convention:
  `[llmux message from thread "cc-last-mile" — another agent, not Jay]`. The recipient
  may have no llmux context, and a peer's request must never arrive looking like an
  instruction from Jay.
- **One line.** A newline is Enter in all these TUIs, so a multi-line message would
  submit itself in fragments; whitespace is collapsed on the way out.
- Nothing is queued: a thread that is not running has no mailbox, which is correct —
  there is nobody to read it.

### A thread that is asking you something turns colour

When an agent asks Jay a question, its row goes to the alert colour and picks up 🙋 —
the same treatment a permission prompt gets. It clears the moment he replies.

`llmux-watch` already did this for questions it could *see*: a choice list, a
permission gate. But it works by reading the pane, and on screen a turn that ends
with a question is identical to a turn that ends with an answer — same prompt, same
idle cursor. So the one thread that needed Jay rendered exactly like the ten that
didn't. The transcript knows the difference, so that is what is read now.

- **Claude threads need no cooperation.** Three hooks
  (`~/.agents/hooks/llmux-asking.sh`) do it: `Notification` when Claude is waiting on
  input, `Stop` when a turn ends *and its last line is a question*, `UserPromptSubmit`
  to clear when Jay replies.
- **Only the last line of the final message counts.** A "?" earlier in a message is
  usually the agent quoting the question it just answered, and a colour that is always
  on stops meaning anything. Measured over ~2,600 real assistant messages, 3% would
  flag.
- **Looking at the thread clears it.** Click the row (or reach it with prefix+j/k, or
  `llmux switch`) and the 🙋 and the colour go at once — the marker exists to tell you
  *which* thread wants you, and once you are in it that job is done. A real permission
  gate or an unanswered choice menu is NOT cleared by looking: those are still
  genuinely unanswered, so `llmux-watch` records WHY a thread is blocked and only the
  asked-in-prose kind retires on sight.
- **Tools without hooks say so themselves**: `llmux asking` / `llmux asking off` —
  codex, amp, opencode, a plain shell.
- **The flag is `@llmux_asking` on the pane, never `@llmux_status`.** `llmux-watch`
  owns the status option and recomputes it every 5s, so anything written there
  directly is erased within one cycle; the watcher reads `@llmux_asking` and promotes
  the thread from `idle` to `blocked`. It also clears it once the thread produces
  sustained output again — that is the backstop if Jay answers somewhere the hook
  never sees.

### The fading "done, and you haven't looked" dot

`idle` itself stays unmarked, but the *subset* of idle that is news does get a mark:
a thread that **finished since you last looked at it** carries a dot and how long ago
it finished.

```
 llmux threads
 ──────────────────────── +

 llmux ─────────────────
▶1 ✳ make-llmux-better          ← on screen: nothing to tell you
  2 ✳ lilo-3240      ● now      ← just finished
  3 ✳ seen-already              ← you already looked

 owner ─────────────────
  4 ◇ me2-shadow     ● 4m
  5 ✳ hermes-flags   ● 26m
  6 ◆ winback-audit  ● 3h       ← fading out
```

The dot **fades** as it ages — bright the moment a turn lands, then down a grey ramp
(`now` → `10m` → `1h` → `6h`) until it sits just above the section-rule grey. A finish is
news when it happens and progressively less so afterwards; a mark that got *louder* with
age would end up out-shouting 🙋 and 🔐, which are the states that actually want you now.

This is why it doesn't reintroduce the 💤 problem: the marked set is only ever
"finished **and** unseen", which is rare, and it empties itself — switching to a thread
clears its dot immediately.

Mechanics, all derived, no new state file:

- `llmux-watch` stamps `@llmux_done_at` on the **finish edge** only, so the age counts
  from the finish rather than resetting every tick.
- Switching to a thread (or focusing it any other way — the sidebar loop checks each
  tick) sets `@llmux_done_at` to the sentinel `0`, meaning "finished, already seen".
  In sidebar mode only one thread is on screen at a time, so "on screen" really is
  "you're looking at it".
- A thread that starts producing output again loses the stamp entirely.
- A `blocked` or `perm` thread shows its flag and **no** dot — the louder state wins
  the row, and nothing competes for columns in a 30-wide pane.

A blocked or permission-gated thread also takes over its row's colour and gets a `·` marker,
the count rides on the title row (`llmux threads  🙋1`), and the pane border spells it out —
`🙋 ANSWER ME` / `🔐 APPROVE?`. There's no hourglass anywhere: it reads as static — easy to
mistake for "stalled" — so `busy` uses 🌀, a spiral, which reads as motion. It's rare anyway,
since most turns finish well inside two minutes.

**If clicking ever stops working, check `tmux show-option -g mouse` first.** `prefix`+`m`
toggles tmux's mouse mode and sits one shift key away from `prefix`+`M` (move thread to
project), so a mistyped move silently kills every sidebar click. The status bar now shows a
red ` MOUSE OFF (prefix+m) ` whenever that has happened.

**Sections are projects.** Threads group by *what you're working on*, not by which
CLI happens to be running in them — the glyph on each row already says that. Each
project gets its own colour-coded section, and **SCRATCH** is drawn first: it's the
unassigned bucket where new threads land, and it's shown even when empty because
that's information too.

Projects are **implicit** — one exists exactly as long as some thread claims it.
There's nothing to create and nothing to delete: name a project on a `mv` and it
appears; move the last thread out and it's gone. A project keeps its position in
the list even while empty (say every thread in it is paused), so it comes back
where you left it rather than jumping to the bottom.

**Moving threads between projects** is the organising gesture:

```sh
llmux mv vip-last-mile owner     # by name
llmux mv 5 owner                 # by sidebar row number
llmux mv vip-last-mile scratch   # back to SCRATCH
llmux mv                         # pick the thread, then the project
llmux mv great-emails-demo owner # works on PAUSED threads too
```

`prefix` + `M` does the same for the thread on screen. Nothing is killed or
relaunched — a thread's project is one pane option, so the agent keeps running and
never notices. Names are lower-cased and slugified (`My Project` → `my-project`),
and the section heading shows them upper-cased.

Paused threads are movable without resuming them: their section is a field in
`paused.json`, so `mv` writes it there instead. Without that, organising a session
would only ever reach whatever happened to be running at the time.

**One `+`, on the rule row under the title.** Click it and it asks which platform
(claude first, so Enter takes it), then the name, then which project — defaulting
to the project of the thread you were looking at, since "another thread in what I'm
working on" is the common case. Pick `shell` as the platform for a plain pane with
no tool, which is `llmux add <name> --tool none` on the command line. New threads
start in the *active thread's* directory, not the sidebar's. Forge is the one
exception: choosing it opens the owned-task picker and attaches that remote task.

Only a click in the `+`'s column counts — clicking the rule or a section label is
deliberately inert, since "click the label" and "click the plus" would otherwise be
one gesture with two meanings.

Nothing is derived from a thread's directory: inside the Owner monorepo every
thread lives in `.workspaces/slot-N`, which would invent a project per slot. New
threads land in SCRATCH unless you say otherwise (`llmux add … --project owner`).

Thread numbering stays global across sections (1…N in draw order), so
`prefix` + `1`…`9`, `llmux switch <n>`, and `llmux next` / `prev` all match the
numbers on screen.

A thread's project lives in the `@llmux_project` pane option (empty = scratch) and
survives `cycle`, `refresh` and `pause`/`resume` — paused threads carry it in
`paused.json`. Section order lives in `@llmux_project_order`, an append-only
session option; `project_sections` is the single source of truth for which sections
exist and in what order, and both the renderer and `list_threads` read it.

### Projects have a home in Tolaria

A project here is a place threads sit. The same piece of work usually also has
*written* memory — the ten-note folder under `Projects/<slug>/` in the
`second-brain` vault. llmux keeps the two attached, so a project isn't just a
sidebar colour:

```sh
llmux project                              # projects ↔ their notes, and vault projects with none
llmux project new  cart-abandon            # scaffold the ten notes for a project
llmux project link vip-launch-me2          # adopt an existing vault project (picker)
llmux project open vip-launch-me2          # open its hub note
llmux project unlink cart-abandon          # detach the notes (they're left alone)
```

Naming a project llmux hasn't seen before — in any picker, or via
`llmux add … --project X` — offers the same three choices: create a Tolaria project,
link an existing one, or no notes at all. Declining is remembered for the session, so
the question is asked once per project rather than once per thread. `--tolaria
<slug|new|none>` answers it up front, which is also the only way a non-interactive
caller can answer it: scripts and agents never get the picker.

Every thread that joins or leaves a project appends one line to that project's
`-log` note, so the vault's history shows the work moving, not just the writing.

**The association is stored in the vault, not in llmux** — `llmux_project: <key>` in
the hub note's frontmatter. Two reasons: it survives `llmux refresh` (which recreates
the tmux session and would drop a session option), and it's legible where a human is
already reading. The common case stores nothing at all, because a project key and a
vault slug spelled the same resolve to each other by name; the explicit link exists
for when they can't be, since project keys are capped at 24 characters and slugs like
`me2-lifecycle-campaigns-migration` are not.

Set `LLMUX_TOLARIA_VAULT` to point elsewhere, or `LLMUX_NO_TOLARIA=1` to turn it off.
With no vault present every one of these paths is a silent no-op, so llmux still works
on a machine that has never seen one.

**Traversing threads:**

| Input | Action |
|---|---|
| click a row | switch to that thread |
| click the `+` | new thread (popup asks platform, name, project) |
| `prefix` + `j` / `k` | next / previous thread (wraps) |
| `prefix` + `Down` / `Up` | same |
| `prefix` + `Tab` | next thread |
| `prefix` + `M` | move the visible thread to another project |
| `prefix` + `1`…`9` | jump to thread by number |
| `llmux switch` | picker |
| `llmux switch <name\|index>`, `llmux next`, `llmux prev` | from a shell |

These are *prefix* bindings on purpose — bare keybindings get swallowed before the
thread's TUI sees them, and Claude/codex need their own `j`/`k`, arrows, and digits.
`prefix` + `0`…`9` is otherwise dead weight in this layout, since there's only one
visible window for `select-window` to select.

Bindings live in the tmux server rather than the session, so they're lost if the
server restarts; re-run `llmux sidebar on` to re-register (it's idempotent).
`llmux sidebar off` restores the tmux defaults it took over.

**The sidebar doesn't scroll.** It always shows current state, so there is nothing
behind it worth scrolling to — the wheel is ignored over that column and scrolls
every other pane as usual. It also clears its own scrollback on each repaint;
before that, a paint every 2s buried the pane in stale copies of itself that you
could scroll into and mistake for live rows.

**Ordering.** Project first, then pinned, then alphabetical. To put specific
threads at the top *of their section*:

```sh
llmux top terminal make-llmux-better   # in the order given
llmux top --reset                      # back to the default
```

Since the project is the primary sort key, `llmux top` reorders within a section —
it can't lift a thread above the ones in the project above it.

Ranks are stored in the `@llmux_order` pane option. This is deliberately *not*
`@llmux_pinned` — in classic mode that option means "the always-visible top-right
pane", so reusing it to reorder the terminal would wedge `apply_layout` on
`sidebar off`.

**Icons.** Each row is prefixed by a glyph for its platform: `❯` shell/terminal,
`✳` claude, `▣` opencode, `◇` codex, `◆` amp, `◈` aider, `●` anything else. Since
sections group by project, this glyph is what tells you which CLI a thread is
running — one column instead of a word. These are single-width BMP glyphs rather
than emoji on purpose — emoji are double-width in most terminals and mixing widths
makes a 30-column list ragged.

**Colour carries two independent axes.** The glyph takes its **platform's** colour
(claude orange, codex cyan, opencode purple, amp pink, aider gold, shell green), while
the row's **number and name** take its **project's** colour. So "what is this" and
"which piece of work is this" are two separate reads, neither needing a legend — and
the two palettes are deliberately disjoint, so a project can never be handed the
colour that means "codex".

Project colours are **unique**, not merely stable. Each project prefers a colour
hashed from its name (so it tends to keep it across sessions with nothing stored), but
a name whose hash is already taken walks to the next free slot — first come keeps its
hash, so adding a project never recolours the ones above it. Without that, collisions
are common rather than theoretical: with 12 slots, two of the projects in this repo's
own session already hash to the same value.

The active thread is marked by `▶` and drawn bold, which is what distinguishes it now
that every name is tinted.

Inactive threads are parked
as panes in a hidden `_parked` window — they keep running, along with their
scrollback, and nothing is relaunched when you switch. `llmux sidebar off` pulls
everything back into the classic terminal/pinned tiled layout.

Migration is non-destructive: enabling sidebar mode turns the panes you already
have into threads without killing or restarting any of them.

### `llmux setup`

Installs dependencies (`gum`, `tmux`, `python3`) via Homebrew, then lets you pick a default LLM CLI from what's on your machine (`amp`, `claude`, `aider`, `sgpt`, `llm`, `mods`, `ollama`) and set startup args (e.g. `--dangerously-skip-permissions`).

Config saved to `~/.config/llmux/config`.

### `llmux add <name> [directory]`

Create a new pane titled `<name>`, optionally in a specific directory. Automatically launches the configured LLM tool.

### `llmux resume [name]`

Harvest past sessions from your configured tool and pick one to resume via a fuzzy-searchable picker (powered by `gum`). Sessions show relative timestamps, the first user message, and the project directory in color.

Harvesters exist for **claude**, **codex**, **opencode** and **amp**. opencode's sessions live
in one sqlite db keyed by directory rather than per-cwd transcript files, and subagent sessions
(rows with a `parent_id`) are filtered out — otherwise one fan-out would bury the picker in a
dozen entries for work you never started.

Entries older than **14 days** — both paused panes and past sessions — are hidden by default to keep the list short. Pass `--all` to include them for one invocation, or set `LLMUX_RESUME_MAX_AGE_DAYS` in your config to change the cutoff (`0` disables filtering). Hidden paused panes still live in `paused.json` and show up in `llmux ls`; only the resume picker hides them.

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
- The bottom-left status bar shows the **active pane's Claude token usage** (`used_k/left_k` against the 1M context window), so you always know how much room is left in the current session
- The configured LLM tool launches automatically in new panes
- `resume` harvests past sessions from the tool's local storage, letting you pick up where you left off — even from sessions started outside llmux
