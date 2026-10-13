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
    'task-list': { tasks: Task[] }
  }

  interface McpToolInputs {
    /** The mod's own todo tool, registered where the built-in task tools are missing */
    'mcp__task-list__todo_write': { todos: Todo[] }
  }
}
