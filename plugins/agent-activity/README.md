# agent-activity

Shows the background agents running in the session above the prompt: what each one is doing right now, and whether it is still active.

```
⠹ Implement Plan 10 Task 8 · running 21 min · Edit …/profile/PlanCard.tsx · 4 s ago
◼ Review Plan 10 Task 7 · running 3 min · Bash: npx vitest run apps/client · 1 min ago
◼ Implement Plan 10 Task 9 · running 30 min · no activity for 7 min
```

## Install

```bash
claude plugin marketplace add vmlinuz82/claude-mods
```

```bash
claude plugin install agent-activity@claude-mods
```

## Usage & expected output

- Nothing to do: the band appears when Claude starts a background agent (a subagent, an implementer, a reviewer) and lists each one while it runs.
- Each line: the agent's description, how long it has run, its latest action (the tool and its file or command) and how long ago that was.

## Behaviour worth knowing

- **The marker spins while the agent is working right now** — it acted in the last 30 seconds: an animated spinner in the desktop app, a text spinner in the terminal. A still `◼` means running but quiet.
- **No activity for 5 minutes turns the line amber** („no activity for 7 min“): a running agent that may be stuck.
- **A line closes when its agent finishes, fails or is stopped;** with no agent running there is no band.
- `×` hides the band until a new agent starts.
- Only background agents that are running are listed: an agent shows when it starts or first acts, and a finished agent that could be resumed (waiting or idle) is not running. The main conversation is the one you are watching.
- The times update every 5 seconds; the engine's agent list is read every 15 seconds.
- Token counts are left to the app's own Background tasks panel.
