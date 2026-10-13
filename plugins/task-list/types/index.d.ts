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

declare module 'claude-code' {
  interface PluginState {
    // closedOn: the list as it was when the band was closed; the band stays hidden until it changes
    'task-list': { tasks: Task[]; closedOn: string | null }
  }

  interface McpToolInputs {
    /** The mod's own todo tool, registered where the built-in task tools are missing */
    'mcp__task-list__todo_write': { todos: Todo[] }
  }
}
