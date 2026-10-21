# task-list

Draws the session's tasks as a checklist above the prompt:

![The task list above the prompt in the desktop app](../../docs/task-list.png)

The first line counts the finished tasks and says what Claude is doing now. A finished task is dimmed and struck through, the one in progress is bold, and the rest wait with an empty box.

## Install

```bash
claude plugin marketplace add vmlinuz82/claude-mods
```

```bash
claude plugin install task-list@claude-mods
```

## Usage & expected output

- Ask Claude for anything with a few steps. The checklist appears as it writes its todo list and ticks off as it works.
- `/task-demo` fills the checklist with sample tasks, `/task-demo clear` empties it — handy to check the mod loaded.

## Behaviour worth knowing

- It follows the built-in `TaskCreate`, `TaskUpdate` and `TodoWrite` tools.
- **Where those tools are missing (the desktop app's Code tab), the mod adds its own, `todo_write`,** so Claude can keep a todo list there too. In the terminal it adds nothing.
- The checklist hides as soon as every task is done.
- **`×` closes the checklist** until the list changes: a new task, or one starting or finishing, brings it back.

## Background agents

The band also shows the background agents running in the session — under the plan task each one works on, matched by its description (`Plan 10 Task 10: referral invites` → Task 10), and the rest under „Other agents“:

```
◼ Task 10 Referral invites · implementing
  ⠹ referral invites · running 5 min · Bash: npx vitest run apps/client · 9 s ago
Other agents
  ◦ Investigate the flaky e2e · running 2 min · Read …/e2e/shots-lib.ts · 1 min ago
```

- **The marker spins while the agent is working right now** (it acted in the last 30 seconds): an animated spinner in the desktop app, a text spinner in the terminal. `◦` means running but quiet; the folded line spins too while any agent works.
- **No activity for 5 minutes turns its line amber** („no activity for 7 min“): a running agent that may be stuck.
- **A tool call still running counts as work** („Bash: ./run test · 6 min so far“): a long test suite or build keeps the agent spinning and never turns it amber.
- An agent shows when it starts or first acts, and leaves when it finishes, fails or is stopped; a finished agent that could be resumed (waiting or idle) is not running.
- The times update every 5 seconds; the engine's agent list is read every 15 seconds. Token counts are left to the app's own Background tasks panel.

## Superpowers plans

While [superpowers](https://github.com/obra/superpowers) runs a plan with subagent-driven development, the band shows that plan, its tasks and the todos of the task in progress:

```
◼ Plan 3 — Frontend Foundation · 1/7 tasks             Details  – ×
  ✔ Task 1 Workspace, shared tooling and packages/ui
  ◼ Task 2 packages/api — OpenAPI types and the client · fix round 1
    ◼ Run the type generation
    ◻ Wire the session client
  ◻ Task 3 The three app shells
```

**`–`** folds the band to one line, where the work is: `□` unfolds it. It stays folded for the rest of the session; every new session starts unfolded.

```
Phase 7 (7/7) \ Plan (3/3) \ Task (3/7) The three app shells · fix round 1      Details  □ ×
```

Without a phase the line starts at `Plan`; with only a todo list it reads `Todo (2/4) Build`.

**Details** (or `/task-tree`) opens a pane with the whole tree: every phase and plan, and the running plan's phase down to each task, done, current and to do.

- It reads superpowers' own files: the plans (`docs/superpowers/plans/*.md`, `### Task N:` headings) and each plan's ledger (`.superpowers/sdd/<plan>/progress.md`). Superpowers itself is unchanged.
- **The running plan is the one whose ledger was written last,** found in the session's folder or the nearest parent with a `.superpowers` folder. A plan only prepared ahead (its workspace holds just the ledger with no task entries, `plan-path` and the task briefs) waits its turn: it becomes the running plan once the started plan before it is finished, the earliest prepared first. A task is done at its `Task N: complete` line (colon optional) or at an approved review with no problem reported beside it; a task in progress shows its latest step (implementing, review, fix round 2…). Tasks may run in parallel, each with its own `◼`. A task the ledger defers (`Ruling: Task 6 … deferred to after Task 7`) shows `◐ … · on hold` until its next entry, and a task implemented but never reviewed while a later task is under way shows `◐ … · implemented, not reviewed`. A task a running agent works on shows `◼` in progress even before its ledger says so. The folded line names the first task in progress and adds `(+n in parallel)`.
- **Phases come from the plan titles:** `Phase 7 · Plan 3 — …`, `… Phase 4 — …` and `… (Phase 1.5)` all work. A sub-phase joins its main phase (3a–3e are Phase 3, 1.5 is Phase 1) and keeps its label in the plan name: `3e · Affiliate Links`. Plans without a phase are listed together.
- **A `MERGED …` line in a ledger marks the whole plan done.** Only the running plan can be in progress: another plan with open tasks shows `◐ … · left open` in the pane.
- **Superpowers' workspaces are scratch and get cleaned:** a plan with no ledger left counts as done when it comes before the running plan (by file name), and to do after it. Ledgers from before superpowers' `# SDD ledger — plan:` first line are read the same way.
- The band shows a plan only while it has unfinished tasks and its ledger changed in the last day; the pane keeps showing the tree after that.
- Superpowers also makes a todo per plan task: those are left out, so each task shows once.
- The tree is read again after a tool call that mentions the ledger and at the end of every turn.
