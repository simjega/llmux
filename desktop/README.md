# llmux Desktop preview

A macOS desktop command center for existing llmux threads, built with Electron, React, TypeScript, and xterm.js.

## Contents

- [What works](#what-works)
- [Architecture](#architecture)
- [Run it](#run-it)
- [Observability](#observability)
- [Validation](#validation)
- [Deliberate gaps](#deliberate-gaps)

## What works

The preview reads the same tmux metadata as the CLI and turns it into a project-first thread list. Selecting a thread watches tmux's event-driven control stream and immediately refreshes an authoritative screen frame when that pane changes; typing in the terminal sends batched keystrokes back to that exact pane. Activity and diagnostics are separate views so operational signals do not compete with the working surface.

![llmux Desktop overview](https://i.imgur.com/6pkb042.png)

| Surface | Current behavior |
|---|---|
| Threads | Groups live panes by llmux project and filters them by name or path |
| Terminal | Refreshes the selected pane on tmux output/layout events and sends batched keyboard input back to tmux |
| Activity | Collects threads that are running, waiting for input, or recently finished |
| Diagnostics | Shows tmux health, frame latency, stream volume, failures, versions, and recent structured events |
| Safety | Uses context isolation, renderer sandboxing, a narrow preload API, validated IPC input, and no remote content |

![llmux Desktop activity queue](https://i.imgur.com/JdS7C1D.png)

## Architecture

Electron is a pragmatic fit for this preview because the existing product boundary is a local tmux session. It gives llmux a mature desktop and browser-testing ecosystem while keeping the shell implementation as the source of truth. A Tauri port would reduce the installed footprint, but it would also introduce a Rust service before the desktop interaction model is proven.

```text
React + xterm.js renderer
          │ narrow typed API
          ▼
 sandboxed preload bridge
          │ validated IPC
          ▼
Electron main process ───────► local JSONL telemetry
          │ control invalidation + bounded frame/input calls
          ▼
tmux %output / list-panes / capture-pane / send-keys
```

The interface borrows a few durable patterns from modern coding apps: a project/thread hierarchy, a separate activity queue, a focused terminal surface, and diagnostics kept out of the primary workspace. Those patterns are documented in OpenAI's guides to [projects](https://learn.chatgpt.com/docs/projects), [notifications](https://learn.chatgpt.com/docs/notifications), [integrated terminals](https://learn.chatgpt.com/docs/integrated-terminal), and [code review](https://learn.chatgpt.com/docs/code-review), and in Anthropic's [Claude project model](https://support.anthropic.com/en/articles/9519177-how-can-i-create-and-manage-projects).

## Run it

Requirements: macOS, Node.js 20.19 or newer, tmux, and an llmux session.

```bash
cd desktop
npm install
npm start
```

By default the app connects to the `llmux` tmux session. To use a disposable or alternate session:

```bash
LLMUX_DESKTOP_SESSION=my-session npm start
```

Package the app into `out/`:

```bash
npm run package
```

## Observability

The main process writes structured JSONL events to Electron's platform log directory as `llmux-desktop.jsonl`. The file is created with mode `0600` and rotates at 5 MB. Events contain timestamps, levels, operation names, durations, and sanitized operational metadata; terminal contents and keystrokes are never logged.

The Diagnostics view exposes:

- tmux connectivity and version
- snapshot and terminal-frame p50/p95 latency
- stream event/byte, frame, metadata-poll, and failure counts
- the last failure and recent structured events
- a button to reveal the local log file

![Diagnostics view](https://i.imgur.com/TV9rwjp.png)

## Validation

```bash
npm run verify     # ESLint, TypeScript, unit tests
npm run package    # packaged macOS arm64 app
npm run test:e2e   # packaged-app tests against an isolated tmux session
```

The end-to-end suite creates `llmux-desktop-e2e`, launches the packaged application through Electron, verifies thread grouping and all three views, types into a real tmux pane, exercises application-mode keys, external resize and forced stream reconnect, measures rendered output latency, and captures the screenshots in this directory.

## Deliberate gaps

This is a direction-setting preview, not an exact port.

- It is validated only on macOS arm64 and is unsigned and unnotarized.
- Thread creation, pause/resume/remove, PR state, reviews, and Tolaria actions remain in the CLI.
- Selecting a row changes only the desktop view; it does not mutate the pane currently visible to an attached tmux client.
- The terminal mirrors the existing pane's exact rows and columns instead of resizing Jay's attached tmux client. Very large panes may be clipped in a smaller desktop window.
- Clipboard paste is deliberately blocked because a captured screen cannot safely reconstruct the pane's bracketed-paste mode. Paste through the attached tmux client until the desktop terminal has a state-preserving PTY bridge.
- The packaged preview retains Electron's inspector switch so Playwright can automate it. A distribution build should use a separate test fuse profile and disable that switch.
- Electron Forge's current packaging dependency reports a development-only `extract-zip` advisory. `npm audit --omit=dev` is clean; distribution work should update the packager when its patched release is available.
