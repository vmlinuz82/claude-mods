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
  // on_hold: started and unfinished while a later task is already under way
  status: TaskStatus | 'on_hold'
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

declare module 'claude-code' {
  interface PluginState {
    // closedOn: what the band showed when it was closed; the band stays hidden until it changes
    // isMinimized: the band folded to one breadcrumb line
    'task-list': { tasks: Task[]; closedOn: string | null; plan: PlanView | null; cwd: string | null; isMinimized: boolean }
  }

  interface McpToolInputs {
    /** The mod's own todo tool, registered where the built-in task tools are missing */
    'mcp__task-list__todo_write': { todos: Todo[] }
  }
}
