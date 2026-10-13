# task-list

Draws the session's tasks as a checklist above the prompt:

```
1/4 done · Computing the response rate…
✔ Read the responses screen      (dimmed, struck through)
◼ Compute the response rate      (bold, in progress)
◻ Add the KPI card
◻ Write tests
```

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
