import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Task, Todo } from '../types'

const tasks = atom({ plugin: 'task-list', key: 'tasks' } as const, [])
const closedOn = atom({ plugin: 'task-list', key: 'closedOn' } as const, null)

const snapshot = (list: readonly Task[]): string => JSON.stringify(list)

const MARK = { pending: '◻', in_progress: '◼', completed: '✔' } as const

// Sessions without the built-in task tools (the desktop app's Code tab) get this one instead
const BUILT_IN_TASK_TOOLS = ['TaskCreate', 'TodoWrite']
const OWN_TOOL = 'mcp__task-list__todo_write'

const isTodo = (value: unknown): value is Todo => {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const { content, status, activeForm } = value as Record<string, unknown>

  return (
    typeof content === 'string' &&
    typeof status === 'string' &&
    status in MARK &&
    (activeForm === undefined || typeof activeForm === 'string')
  )
}

const fromTodos = (todos: readonly Todo[]): Task[] =>
  todos.map((todo, index) => ({
    id: `todo-${index}`,
    subject: todo.content,
    activeForm: todo.activeForm,
    status: todo.status,
  }))

const DEMO: Task[] = [
  { id: 'demo-1', subject: 'Read the responses screen', status: 'completed' },
  { id: 'demo-2', subject: 'Compute the response rate', activeForm: 'Computing the response rate', status: 'in_progress' },
  { id: 'demo-3', subject: 'Add the KPI card', status: 'pending' },
  { id: 'demo-4', subject: 'Write tests', status: 'pending' },
]

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'task-demo',
      description: 'Fill the task band with sample tasks; `/task-demo clear` empties it',
    })

    const tools = await $.tool.list()
    if (!tools.some(one => BUILT_IN_TASK_TOOLS.includes(one.name))) {
      await $.tool.register({
        name: 'todo_write',
        description:
          'Create and update the todo list for the current work; the person sees it as a checklist above the prompt. ' +
          'Use it for any task with three or more steps: write the whole list at the start, keep exactly one item ' +
          'in_progress, and send the whole list again each time an item starts or finishes. Every call replaces the list.',
        inputSchema: {
          type: 'object',
          properties: {
            todos: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  content: { type: 'string', description: 'What to do, in the imperative: "Run the tests"' },
                  activeForm: { type: 'string', description: 'The same, while it runs: "Running the tests"' },
                  status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                },
                required: ['content', 'status', 'activeForm'],
              },
            },
          },
          required: ['todos'],
        },
      })
    }

    return next(e)
  })

  on('tool.call', { tool: OWN_TOOL }, async ($, e) => {
    // The model's input is not checked against the schema on the way in
    const todos: unknown = e.todos
    if (!Array.isArray(todos) || !todos.every(isTodo)) {
      return { deny: 'todos must be a list of { content, status, activeForm }, status one of pending, in_progress, completed' }
    }

    await update($, tasks, () => fromTodos(todos))
    const done = todos.filter(todo => todo.status === 'completed').length

    return { result: `Todo list updated: ${done}/${todos.length} done.` }
  })

  on('command.run', { command: 'task-demo' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, tasks, () => [])

      return { text: 'Task band cleared.' }
    }

    await update($, tasks, () => DEMO)

    return { text: 'Sample tasks added above the prompt.' }
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.isError || !ran.result) {
      return ran
    }

    const task: Task = {
      id: ran.result.task.id,
      subject: e.subject,
      activeForm: e.activeForm,
      status: 'pending',
    }
    await update($, tasks, list => [...list.filter(one => one.id !== task.id), task])

    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.isError || !ran.result?.success) {
      return ran
    }

    const { taskId, status, subject, activeForm } = e
    if (status === 'deleted') {
      await update($, tasks, list => list.filter(one => one.id !== taskId))

      return ran
    }

    await update($, tasks, list =>
      list.map(one =>
        one.id !== taskId
          ? one
          : {
              ...one,
              status: status ?? one.status,
              subject: subject ?? one.subject,
              activeForm: activeForm ?? one.activeForm,
            },
      ),
    )

    return ran
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.isError) {
      return ran
    }

    await update($, tasks, () => fromTodos(e.todos))

    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, tasks)
    const done = list.filter(one => one.status === 'completed').length
    // A finished list is history, not current work, so it hides even while Claude keeps working
    const isFinished = done === list.length

    // Closed by the person: hidden until the list changes
    const isClosed = (await read($, closedOn)) === snapshot(list)

    if (e.props.hasSurvey || list.length === 0 || isFinished || isClosed) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const active = list.find(one => one.status === 'in_progress')

    return (
      <Box flexDirection="column">
        <Box key="head" flexDirection="row" justifyContent="space-between" columnGap={2}>
          <Text key="summary" dimColor>
            {done}/{list.length} done{active?.activeForm ? ` · ${active.activeForm}…` : ''}
          </Text>
          <Button
            key="close"
            label="✕"
            role="dismiss"
            plain
            dimColor
            onPress={() => update($, closedOn, () => snapshot(list))}
          />
        </Box>
        {list.map(task => (
          <Text
            key={task.id}
            bold={task.status === 'in_progress'}
            dimColor={task.status === 'completed'}
            strikethrough={task.status === 'completed'}
          >
            {MARK[task.status]} {task.subject}
          </Text>
        ))}
      </Box>
    )
  })
}
