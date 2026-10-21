export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type Task = {
  id: string
  subject: string
  activeForm?: string
  status: TaskStatus
}

export type Todo = {
  content: string
  status: TaskStatus
  activeForm?: string
}

// One task of a superpowers plan, its status from the subagent-driven-development ledger
export type PlanTask = {
  n: number
  title: string
  // on_hold: deferred by the ledger; unreviewed: implemented, no review yet, while a later task is under way
  status: TaskStatus | 'on_hold' | 'unreviewed'
  // The latest ledger step of a task in progress: implementing, review, fix round 2…
  step?: string
}

// One plan in the plans folder, with its tasks as its own ledger has them
export type PlanRow = {
  name: string
  // on_hold: a plan other than the running one, with tasks left open
  status: TaskStatus | 'on_hold'
  isCurrent: boolean
  tasks: PlanTask[]
}

// The plans of one phase, in file name order; phase null holds the plans without a phase
export type PhaseGroup = {
  phase: string | null
  plans: PlanRow[]
}

// The plan of the newest superpowers ledger and every plan beside it
export type PlanView = {
  // false once every task of the plan is complete: the band hides it, the pane keeps it
  isRunning: boolean
  phase: string | null
  name: string
  tasks: PlanTask[]
  groups: PhaseGroup[]
}

// One running background agent, as this mod follows it
export type TrackedAgent = {
  id: string
  // The Agent tool's description: „Plan 10 Task 10: referral invites“
  description: string
  // When it started (or was first seen acting), and when it last did something
  startedAt: number
  lastAt: number
  // Its latest tool call, shortened: „Edit …/profile/PlanCard.tsx“; null before its first
  lastAction: string | null
  // How many of its tool calls are still running: a long test run is work, not silence
  toolsRunning: number
}

declare module 'claude-code' {
  interface PluginState {
    // closedOn: what the band showed when it was closed; the band stays hidden until it changes
    // isMinimized: the band folded to one breadcrumb line
    // agents: the running background agents; clock: the time as last read, for „running 5 min“ and „9 s ago“;
    // frame: the terminal spinner's step
    'task-list': {
      tasks: Task[]
      closedOn: string | null
      plan: PlanView | null
      cwd: string | null
      isMinimized: boolean
      agents: TrackedAgent[]
      clock: number
      frame: number
    }
  }

  interface McpToolInputs {
    /** The mod's own todo tool, registered where the built-in task tools are missing */
    'mcp__task-list__todo_write': { todos: Todo[] }
  }
}
