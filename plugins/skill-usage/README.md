# skill-usage

Shows which skills and MCP servers were used in the current session and how many times.

Above the prompt, the five most used of each:

```
Skills  plugin-authoring 2  review 1
MCP     workbench-gitlab 4  workbench-jira 1
```

## Install

```bash
claude plugin marketplace add vmlinuz82/claude-mods
```

```bash
claude plugin install skill-usage@claude-mods
```

## Usage & expected output

- Click `Skills` or `MCP` above the prompt, or run `/skill-usage`, for a pane with a table of every skill and MCP server used in the session, most used first.

## Behaviour worth knowing

- **Counts are per session** and start at 0 in each new one.
- A skill counts each time it's used: called by Claude, or typed as `/name`. Skills preloaded into a subagent's definition aren't counted. An MCP server counts each call to one of its tools.
- The band stays hidden until something is used, and each line appears only once its group has a use.
- **`✕` closes the band** until the next skill or MCP use; the pane stays available from `/skill-usage`.
- Skills and MCP servers with no uses never appear, in the band or the pane.
- The list of skills and servers is read again at every turn, since MCP servers often connect after the session starts.
