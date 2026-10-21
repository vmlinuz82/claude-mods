// One running background agent, as this mod follows it
export type TrackedAgent = {
  id: string
  // The Agent tool's description: „Implement Plan 10 Task 8“
  description: string
  // When it started (or was first seen), and when it last did something
  startedAt: number
  lastAt: number
  // Its latest tool call, shortened: „Edit …/profile/PlanCard.tsx“, „Bash: npx vitest run“; null before its first
  lastAction: string | null
}

declare module 'claude-code' {
  interface PluginState {
    // now: the clock as last read, for „running 21 min“ and „12 s ago“; frame: the terminal spinner's step;
    // closedOn: the agent ids the band was closed on — hidden until a new agent starts
    'agent-activity': { agents: TrackedAgent[]; now: number; frame: number; closedOn: string[] | null }
  }
}
