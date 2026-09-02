#!/usr/bin/env bash
set -euo pipefail

LLMUX_BIN="$(cd "$(dirname "$0")/.." && pwd)/llmux"
TEST_ROOT="$(mktemp -d "/tmp/lmx-rec.XXXXXX")"
ORIGINAL_PATH="$PATH"
SESSION="llmux-recovery-test-$$"
CLAUDE_ID="11111111-1111-4111-8111-111111111111"
CODEX_ID="22222222-2222-4222-8222-222222222222"
FORGE_ID="tsk-RestoreRetry123"

cleanup() {
  local pidfile="/tmp/llmux-watch-${SESSION}.pid"
  [[ -f "$pidfile" ]] && kill "$(cat "$pidfile")" 2>/dev/null || true
  TMUX_TMPDIR="$TMUX_TMPDIR" tmux kill-server 2>/dev/null || true
  [[ "$TEST_ROOT" == "/tmp/lmx-rec."* ]] && rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
assert_eq() { [[ "$1" == "$2" ]] || fail "expected '$2', got '$1' (${3:-})"; }

export HOME="$TEST_ROOT/home"
export XDG_CONFIG_HOME="$TEST_ROOT/config"
export TMUX_TMPDIR="$TEST_ROOT/tmux"
export ZDOTDIR="$TEST_ROOT/zdot"
export LLMUX_SESSION="$SESSION"
export LLMUX_SLOT_CLEANUP_HOURS=0
export LLMUX_TEST_LOG="$TEST_ROOT/log"
export PATH="$TEST_ROOT/bin:$ORIGINAL_PATH"
mkdir -p "$HOME" "$XDG_CONFIG_HOME/llmux" "$TMUX_TMPDIR" "$ZDOTDIR" \
  "$TEST_ROOT/bin" "$LLMUX_TEST_LOG" "$TEST_ROOT/project"

cat > "$ZDOTDIR/.zshrc" <<EOF
export PATH="$TEST_ROOT/bin:$ORIGINAL_PATH"
export LLMUX_TEST_LOG="$LLMUX_TEST_LOG"
EOF
cat > "$TEST_ROOT/bin/claude" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$LLMUX_TEST_LOG/claude"
exec sleep 60
EOF
cat > "$TEST_ROOT/bin/codex" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$LLMUX_TEST_LOG/codex"
exec sleep 60
EOF
cat > "$TEST_ROOT/bin/forge" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$LLMUX_TEST_LOG/forge"
exec sleep 60
EOF
cat > "$TEST_ROOT/bin/noop" <<'EOF'
#!/bin/sh
exec sleep 60
EOF
chmod +x "$TEST_ROOT/bin/claude" "$TEST_ROOT/bin/codex" "$TEST_ROOT/bin/forge" "$TEST_ROOT/bin/noop"

cat > "$XDG_CONFIG_HOME/llmux/config" <<EOF
LLMUX_PINNED_NAME="configured-pinned"
LLMUX_PINNED_DIR="$TEST_ROOT/project"
LLMUX_PINNED_TOOL="claude"
LLMUX_TOOL="claude"
EOF

# Durable identities used by restore preflight.
for cwd in "$TEST_ROOT/project" "$(cd "$TEST_ROOT/project" && pwd -P)"; do
  slug="${cwd//\//-}"
  mkdir -p "$HOME/.claude/projects/$slug"
  : > "$HOME/.claude/projects/$slug/$CLAUDE_ID.jsonl"
done
mkdir -p "$HOME/.codex"
sqlite3 "$HOME/.codex/state_5.sqlite" \
  'CREATE TABLE threads(id TEXT PRIMARY KEY, cwd TEXT, updated_at INTEGER, title TEXT, archived INTEGER DEFAULT 0);'
sqlite3 "$HOME/.codex/state_5.sqlite" \
  "INSERT INTO threads(id,cwd,updated_at,title) VALUES('$CODEX_ID','$TEST_ROOT/project',0,'fixture');"

# Build a rich source session without involving llmux startup.
tmux new-session -d -s "$SESSION" -x 220 -y 60 -c "$TEST_ROOT/project"
tmux set-option -t "$SESSION" @llmux_instance_id original-instance
tmux set-option -t "$SESSION" @llmux_sidebar_mode 1
terminal=$(tmux list-panes -t "$SESSION" -F '#{pane_id}' | head -1)
tmux set-option -p -t "$terminal" @llmux_name terminal
tmux set-option -p -t "$terminal" @llmux_terminal 1

pinned=$(tmux new-window -d -t "$SESSION:" -c "$TEST_ROOT/project" -P -F '#{pane_id}')
tmux set-option -p -t "$pinned" @llmux_name saved-pinned
tmux set-option -p -t "$pinned" @llmux_tool claude
tmux set-option -p -t "$pinned" @llmux_pinned 1
tmux set-option -p -t "$pinned" @llmux_claude_session "$CLAUDE_ID"

codex_pane=$(tmux new-window -d -t "$SESSION:" -c "$TEST_ROOT/project" -P -F '#{pane_id}')
tmux set-option -p -t "$codex_pane" @llmux_name exact-codex
tmux set-option -p -t "$codex_pane" @llmux_tool codex
tmux set-option -p -t "$codex_pane" @llmux_codex_session "$CODEX_ID"

for i in $(seq 1 12); do
  pane=$(tmux new-window -d -t "$SESSION:" -c "$TEST_ROOT/project" -P -F '#{pane_id}')
  tmux set-option -p -t "$pane" @llmux_name "thread-$i"
  tmux set-option -p -t "$pane" @llmux_project capacity
done
"$LLMUX_BIN" snapshot save >/dev/null

# A new bare instance, even with maintenance, cannot replace a rich snapshot.
tmux kill-session -t "$SESSION"
tmux new-session -d -s "$SESSION" -x 220 -y 60 -c "$TEST_ROOT/project"
tmux set-option -t "$SESSION" @llmux_instance_id replacement-instance
partial_terminal=$(tmux list-panes -t "$SESSION" -F '#{pane_id}' | head -1)
tmux set-option -p -t "$partial_terminal" @llmux_name terminal
tmux set-option -p -t "$partial_terminal" @llmux_terminal 1
maintenance=$(tmux new-window -d -t "$SESSION:" -c "$TEST_ROOT/project" -P -F '#{pane_id}')
tmux set-option -p -t "$maintenance" @llmux_name slot-cleanup
tmux set-option -p -t "$maintenance" @llmux_maintenance slot-cleanup
if "$LLMUX_BIN" _snapshot >/dev/null 2>&1; then
  fail "partial replacement snapshot was accepted"
fi
saved_count=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["session"]["threads"]))' \
  "$XDG_CONFIG_HOME/llmux/paused.json")
assert_eq "$saved_count" 15 "complete snapshot remained on disk"

# A crash auto-restores every pane, exact IDs, and sidebar furniture.
tmux kill-session -t "$SESSION"
set +e
"$LLMUX_BIN" prompt trigger --name trigger --tool noop --background >/dev/null
prompt_rc=$?
set -e
if [[ "$prompt_rc" != "0" ]]; then
  tmux list-panes -s -t "$SESSION" -F '#{pane_id}|#{@llmux_name}|#{@llmux_tool}|#{@llmux_recovery_pane}' >&2 || true
  python3 -m json.tool "$XDG_CONFIG_HOME/llmux/paused.json" >&2 || true
  fail "prompt after restore exited $prompt_rc"
fi
for _ in $(seq 1 100); do
  [[ -s "$LLMUX_TEST_LOG/claude" && -s "$LLMUX_TEST_LOG/codex" ]] && break
  sleep 0.1
done
restored_count=$(tmux list-panes -s -t "$SESSION" -F '#{@llmux_name}' \
  | awk '/^(saved-pinned|exact-codex|thread-[0-9]+)$/{n++} END{print n+0}')
assert_eq "$restored_count" 14 "all saved non-terminal threads restored"
assert_eq "$(tmux list-panes -s -t "$SESSION" -F '#{@llmux_pinned}' | awk '$1==1{n++} END{print n+0}')" 1 "one pinned pane"
assert_eq "$(tmux list-panes -s -t "$SESSION" -F '#{@llmux_sidebar}' | awk '$1==1{n++} END{print n+0}')" 1 "one sidebar"
assert_eq "$(tmux list-panes -s -t "$SESSION" -F '#{@llmux_parked_anchor}' | awk '$1==1{n++} END{print n+0}')" 1 "one parked anchor"
grep -q -- "--resume $CLAUDE_ID -n saved-pinned" "$LLMUX_TEST_LOG/claude" \
  || fail "Claude was not resumed by exact ID"
grep -q -- "resume $CODEX_ID" "$LLMUX_TEST_LOG/codex" \
  || fail "Codex was not resumed by exact ID"
watch_pidfile="/tmp/llmux-watch-${SESSION}.pid"
for _ in $(seq 1 20); do
  [[ -s "$watch_pidfile" ]] && break
  sleep 0.1
done
[[ -s "$watch_pidfile" ]] || fail "restore did not start a watcher"
old_watch_pid=$(cat "$watch_pidfile")
kill -0 "$old_watch_pid" 2>/dev/null || fail "restored watcher is not alive"
"$LLMUX_BIN" _watch >/dev/null
for _ in $(seq 1 20); do
  [[ -s "$watch_pidfile" ]] && break
  sleep 0.1
done
[[ -s "$watch_pidfile" ]] || fail "watcher restart did not publish its pid"
new_watch_pid=$(cat "$watch_pidfile")
kill -0 "$new_watch_pid" 2>/dev/null || fail "replacement watcher is not alive"
for _ in $(seq 1 100); do
  old_watch_state=$(ps -p "$old_watch_pid" -o state= 2>/dev/null | tr -d ' ' || true)
  [[ -z "$old_watch_state" || "$old_watch_state" == Z* ]] && break
  sleep 0.1
done
old_watch_state=$(ps -p "$old_watch_pid" -o state= 2>/dev/null | tr -d ' ' || true)
[[ "$old_watch_pid" == "$new_watch_pid" || -z "$old_watch_state" || "$old_watch_state" == Z* ]] \
  || fail "watcher restart left two watcher processes alive"
python3 - "$XDG_CONFIG_HOME/llmux/paused.json" <<'PY' || fail "add was not synchronously snapshotted"
import json, sys
d = json.load(open(sys.argv[1]))
assert any(t.get("name") == "trigger" for t in d["session"]["threads"])
PY
live_identity=$(tmux list-panes -s -t "$SESSION" \
  -F '#{@llmux_name}|#{@llmux_tool}|#{@llmux_claude_session}|#{@llmux_opencode_session}|#{@llmux_codex_session}|#{@llmux_sidebar}|#{@llmux_parked_anchor}' \
  | awk -F'|' '$1!="" && $6!="1" && $7!="1"{print $1"|"$2"|"$3"|"$4"|"$5}' | LC_ALL=C sort)
disk_identity=$(python3 - "$XDG_CONFIG_HOME/llmux/paused.json" <<'PY' | LC_ALL=C sort
import json, sys
d = json.load(open(sys.argv[1]))
for t in d["session"]["threads"]:
    print("|".join(t.get(k, "") for k in
          ("name", "tool", "claude_session", "opencode_session", "codex_session")))
PY
)
assert_eq "$live_identity" "$disk_identity" "live and durable thread identities match"

# Project/color and ordering changes are durable before the command returns.
"$LLMUX_BIN" mv thread-2 recovery-project --no-tolaria >/dev/null
"$LLMUX_BIN" top thread-2 >/dev/null
python3 - "$XDG_CONFIG_HOME/llmux/paused.json" <<'PY' || fail "project/order metadata was not synchronously snapshotted"
import json, sys
threads = json.load(open(sys.argv[1]))["session"]["threads"]
t = next(t for t in threads if t.get("name") == "thread-2")
assert t.get("project") == "recovery-project"
assert t.get("order") == "10"
PY

# A deliberate tool switch may replace only that thread's identity.
CYCLE_NO_ATTACH=1 "$LLMUX_BIN" cycle thread-1 --tool noop >/dev/null
python3 - "$XDG_CONFIG_HOME/llmux/paused.json" <<'PY' || fail "cycle tool switch was not committed"
import json, sys
threads = json.load(open(sys.argv[1]))["session"]["threads"]
assert next(t for t in threads if t.get("name") == "thread-1").get("tool") == "noop"
PY

# An out-of-band pane loss is not authorization to forget the thread.
lost_pane=$(tmux list-panes -s -t "$SESSION" -F '#{pane_id}|#{@llmux_name}' \
  | awk -F'|' '$2=="thread-12"{print $1; exit}')
tmux kill-pane -t "$lost_pane"
if "$LLMUX_BIN" _snapshot >/dev/null 2>&1; then
  fail "implicit pane loss replaced the complete snapshot"
fi
if "$LLMUX_BIN" snapshot save >/dev/null 2>&1; then
  fail "public snapshot save bypassed the completeness guard"
fi
# Removing B cannot authorize an unrelated already-missing A.
if "$LLMUX_BIN" rm thread-11 >/dev/null 2>&1; then
  fail "scoped removal authorized an unrelated missing thread"
fi
pause_output=""
if pause_output=$("$LLMUX_BIN" pause thread-10 2>&1); then
  fail "pause swallowed a refused snapshot"
fi
[[ "$pause_output" != *"Paused 'thread-10'"* ]] \
  || fail "pause claimed success before its snapshot committed"
cycle_output=""
if cycle_output=$(CYCLE_NO_ATTACH=1 "$LLMUX_BIN" cycle thread-9 --tool none 2>&1); then
  fail "cycle --tool none swallowed a refused snapshot"
fi
[[ "$cycle_output" != *"Cycled 'thread-9'"* ]] \
  || fail "cycle --tool none claimed success before its snapshot committed"
tmux set-option -t "$SESSION" @llmux_sidebar_mode 0
if "$LLMUX_BIN" cycle all >/dev/null 2>&1; then
  fail "cycle all swallowed refused child snapshots"
fi
python3 - "$XDG_CONFIG_HOME/llmux/paused.json" <<'PY' || fail "lost pane disappeared from recovery"
import json, sys
d = json.load(open(sys.argv[1]))
assert any(t.get("name") == "thread-12" for t in d["session"]["threads"])
assert any(t.get("name") == "thread-11" for t in d["session"]["threads"])
PY

# Deliberate kill is not a crash and must not resurrect.
"$LLMUX_BIN" kill >/dev/null
python3 - "$XDG_CONFIG_HOME/llmux/paused.json" <<'PY' || fail "kill retained the live-session snapshot"
import json, sys
assert "session" not in json.load(open(sys.argv[1]))
PY

# Classic mode restores large sessions without depending on split-pane capacity.
export LLMUX_SESSION="llmux-classic-test-$$"
export XDG_CONFIG_HOME="$TEST_ROOT/classic-config"
mkdir -p "$XDG_CONFIG_HOME/llmux"
cp "$TEST_ROOT/config/llmux/config" "$XDG_CONFIG_HOME/llmux/config"
tmux new-session -d -s "$LLMUX_SESSION" -x 120 -y 30 -c "$TEST_ROOT/project"
tmux set-option -t "$LLMUX_SESSION" @llmux_instance_id classic-original
classic_terminal=$(tmux list-panes -t "$LLMUX_SESSION" -F '#{pane_id}' | head -1)
tmux set-option -p -t "$classic_terminal" @llmux_name terminal
tmux set-option -p -t "$classic_terminal" @llmux_terminal 1
for i in $(seq 1 12); do
  pane=$(tmux new-window -d -t "$LLMUX_SESSION:" -c "$TEST_ROOT/project" -P -F '#{pane_id}')
  tmux set-option -p -t "$pane" @llmux_name "classic-$i"
done
"$LLMUX_BIN" snapshot save >/dev/null
tmux kill-session -t "$LLMUX_SESSION"
"$LLMUX_BIN" prompt classic-trigger --name classic-trigger --tool noop --background >/dev/null
assert_eq "$(tmux list-panes -s -t "$LLMUX_SESSION" -F '#{@llmux_name}' | awk '/^classic-[0-9]+$/{n++} END{print n+0}')" 12 "classic capacity restore"
assert_eq "$(tmux list-panes -s -t "$LLMUX_SESSION" -F '#{pane_dead}' | awk '$1==1{n++} END{print n+0}')" 0 "restored panes are alive"
"$LLMUX_BIN" kill >/dev/null

# A missing transcript leaves a persistent, retryable recovery transaction.
BAD_ID="33333333-3333-4333-8333-333333333333"
export LLMUX_SESSION="llmux-invalid-test-$$"
export XDG_CONFIG_HOME="$TEST_ROOT/invalid-config"
mkdir -p "$XDG_CONFIG_HOME/llmux"
cp "$TEST_ROOT/config/llmux/config" "$XDG_CONFIG_HOME/llmux/config"
tmux new-session -d -s "$LLMUX_SESSION" -x 200 -y 50 -c "$TEST_ROOT/project"
tmux set-option -t "$LLMUX_SESSION" @llmux_instance_id invalid-original
bad_terminal=$(tmux list-panes -t "$LLMUX_SESSION" -F '#{pane_id}' | head -1)
tmux set-option -p -t "$bad_terminal" @llmux_name terminal
tmux set-option -p -t "$bad_terminal" @llmux_terminal 1
bad_pane=$(tmux new-window -d -t "$LLMUX_SESSION:" -c "$TEST_ROOT/project" -P -F '#{pane_id}')
tmux set-option -p -t "$bad_pane" @llmux_name missing-transcript
tmux set-option -p -t "$bad_pane" @llmux_tool claude
tmux set-option -p -t "$bad_pane" @llmux_claude_session "$BAD_ID"
retry_forge=$(tmux new-window -d -t "$LLMUX_SESSION:" -c "$TEST_ROOT/project" -P -F '#{pane_id}')
tmux set-option -p -t "$retry_forge" @llmux_name retry-forge
tmux set-option -p -t "$retry_forge" @llmux_tool forge
tmux set-option -p -t "$retry_forge" @llmux_forge_task "$FORGE_ID"
"$LLMUX_BIN" snapshot save >/dev/null
tmux kill-session -t "$LLMUX_SESSION"
if "$LLMUX_BIN" prompt blocked --name blocked --tool noop --background >/dev/null 2>&1; then
  fail "missing transcript reported a successful recovery"
fi
assert_eq "$(tmux show-option -t "$LLMUX_SESSION" -qv @llmux_restoring)" 1 "recovery remains retryable"
[[ -n "$(tmux show-option -t "$LLMUX_SESSION" -qv @llmux_restore_error)" ]] \
  || fail "missing transcript did not publish a visible error"
for cwd in "$TEST_ROOT/project" "$(cd "$TEST_ROOT/project" && pwd -P)"; do
  slug="${cwd//\//-}"
  mkdir -p "$HOME/.claude/projects/$slug"
  : > "$HOME/.claude/projects/$slug/$BAD_ID.jsonl"
done
"$LLMUX_BIN" restore --force >/dev/null
[[ -z "$(tmux show-option -t "$LLMUX_SESSION" -qv @llmux_restoring)" ]] \
  || fail "successful retry left recovery marked in progress"
[[ -z "$(tmux show-option -t "$LLMUX_SESSION" -qv @llmux_restore_error)" ]] \
  || fail "successful retry left the recovery error visible"
assert_eq "$(tmux list-panes -s -t "$LLMUX_SESSION" -F '#{@llmux_name}|#{@llmux_forge_task}' | awk -F'|' '$1=="retry-forge"{print $2}')" "$FORGE_ID" "Forge identity survived recovery retry"
grep -q -- "task open $FORGE_ID" "$LLMUX_TEST_LOG/forge" \
  || fail "Forge task was not resumed by exact ID during recovery"
"$LLMUX_BIN" kill >/dev/null

# Pre-identity snapshots never silently start a replacement LLM conversation.
export LLMUX_SESSION="llmux-identityless-test-$$"
export XDG_CONFIG_HOME="$TEST_ROOT/identityless-config"
mkdir -p "$XDG_CONFIG_HOME/llmux"
python3 - "$XDG_CONFIG_HOME/llmux/paused.json" "$TEST_ROOT/project" <<'PY'
import json, sys, time
json.dump({"paused": [], "prs": [], "session": {
    "saved_at": int(time.time()), "threads": [
        {"name": "terminal", "dir": sys.argv[2], "terminal": "1"},
        {"name": "legacy-codex", "dir": sys.argv[2], "tool": "codex"},
    ], "options": {"sidebar_mode": "0"}}}, open(sys.argv[1], "w"))
PY
codex_before=$(wc -l < "$LLMUX_TEST_LOG/codex" | tr -d ' ')
if "$LLMUX_BIN" prompt blocked --name blocked --tool noop --background >/dev/null 2>&1; then
  fail "identityless Codex snapshot reported successful recovery"
fi
codex_after=$(wc -l < "$LLMUX_TEST_LOG/codex" | tr -d ' ')
assert_eq "$codex_after" "$codex_before" "identityless recovery launched no replacement conversation"
[[ -n "$(tmux show-option -t "$LLMUX_SESSION" -qv @llmux_restore_error)" ]] \
  || fail "identityless recovery did not publish a visible error"
tmux kill-session -t "$LLMUX_SESSION"

# The current binary still reads the original bare-list paused.json format.
export LLMUX_SESSION="llmux-legacy-test-$$"
export XDG_CONFIG_HOME="$TEST_ROOT/legacy-config"
mkdir -p "$XDG_CONFIG_HOME/llmux"
python3 - "$XDG_CONFIG_HOME/llmux/paused.json" "$TEST_ROOT/project" <<'PY'
import json, sys
with open(sys.argv[1], "w") as f:
    json.dump([{"name": "legacy-paused", "dir": sys.argv[2],
                "tool": "claude", "paused_at": 1}], f)
PY
tmux new-session -d -s "$LLMUX_SESSION" -x 200 -y 50 -c "$TEST_ROOT/project"
"$LLMUX_BIN" ls | grep -q "legacy-paused" \
  || fail "legacy list-form paused state was not readable"
tmux kill-session -t "$LLMUX_SESSION"

# Sidebar mode changes are committed synchronously in both directions.
export LLMUX_SESSION="llmux-sidebar-state-test-$$"
export XDG_CONFIG_HOME="$TEST_ROOT/sidebar-state-config"
mkdir -p "$XDG_CONFIG_HOME/llmux"
cp "$TEST_ROOT/config/llmux/config" "$XDG_CONFIG_HOME/llmux/config"
tmux new-session -d -s "$LLMUX_SESSION" -x 200 -y 50 -c "$TEST_ROOT/project"
sidebar_thread=$(tmux list-panes -t "$LLMUX_SESSION" -F '#{pane_id}' | head -1)
tmux set-option -p -t "$sidebar_thread" @llmux_name sidebar-fixture
"$LLMUX_BIN" snapshot save >/dev/null
"$LLMUX_BIN" sidebar on >/dev/null
assert_eq "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["session"]["options"]["sidebar_mode"])' "$XDG_CONFIG_HOME/llmux/paused.json")" 1 "sidebar-on snapshot"
"$LLMUX_BIN" sidebar off >/dev/null
assert_eq "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["session"]["options"]["sidebar_mode"])' "$XDG_CONFIG_HOME/llmux/paused.json")" 0 "sidebar-off snapshot"
"$LLMUX_BIN" kill >/dev/null

# Existing malformed state fails closed and is byte-for-byte untouched.
export LLMUX_SESSION="llmux-malformed-test-$$"
export XDG_CONFIG_HOME="$TEST_ROOT/malformed-config"
mkdir -p "$XDG_CONFIG_HOME/llmux"
printf '%s' '{"session": [invalid]' > "$XDG_CONFIG_HOME/llmux/paused.json"
before=$(shasum "$XDG_CONFIG_HOME/llmux/paused.json" | awk '{print $1}')
if "$LLMUX_BIN" prompt nope --name nope --tool noop --background >/dev/null 2>&1; then
  fail "malformed state booted a blank session"
fi
tmux has-session -t "$LLMUX_SESSION" 2>/dev/null && fail "malformed state created a tmux session"
after=$(shasum "$XDG_CONFIG_HOME/llmux/paused.json" | awk '{print $1}')
assert_eq "$after" "$before" "malformed state remained untouched"

# Valid JSON with an invalid internal schema is equally unsafe.
export LLMUX_SESSION="llmux-schema-test-$$"
export XDG_CONFIG_HOME="$TEST_ROOT/schema-config"
mkdir -p "$XDG_CONFIG_HOME/llmux"
printf '%s' '{"paused":[],"prs":[],"session":"wrong-type"}' > "$XDG_CONFIG_HOME/llmux/paused.json"
before=$(shasum "$XDG_CONFIG_HOME/llmux/paused.json" | awk '{print $1}')
if "$LLMUX_BIN" prompt nope --name nope --tool noop --background >/dev/null 2>&1; then
  fail "wrong-schema state booted a blank session"
fi
tmux has-session -t "$LLMUX_SESSION" 2>/dev/null && fail "wrong-schema state created a tmux session"
after=$(shasum "$XDG_CONFIG_HOME/llmux/paused.json" | awk '{print $1}')
assert_eq "$after" "$before" "wrong-schema state remained untouched"

printf '%s' '{"paused":[],"prs":[],"session":{"threads":["wrong-entry"]}}' > "$XDG_CONFIG_HOME/llmux/paused.json"
before=$(shasum "$XDG_CONFIG_HOME/llmux/paused.json" | awk '{print $1}')
if "$LLMUX_BIN" prompt nope --name nope --tool noop --background >/dev/null 2>&1; then
  fail "wrong thread-entry schema booted a blank session"
fi
tmux has-session -t "$LLMUX_SESSION" 2>/dev/null && fail "wrong thread-entry schema created a tmux session"
after=$(shasum "$XDG_CONFIG_HOME/llmux/paused.json" | awk '{print $1}')
assert_eq "$after" "$before" "wrong thread-entry schema remained untouched"

snapshot_output=""
if snapshot_output=$("$LLMUX_BIN" snapshot save 2>&1); then
  fail "snapshot save succeeded without a live tmux session"
fi
[[ "$snapshot_output" != *"Snapshot saved."* ]] \
  || fail "failed snapshot claimed it was saved"

echo "recovery tests passed"
