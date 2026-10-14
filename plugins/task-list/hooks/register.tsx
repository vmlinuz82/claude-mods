import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { PlanTask, PlanView, Task, Todo } from '../types'
import { breadcrumb, isPlanTodo, loadPlanView } from './sdd'

const tasks = atom({ plugin: 'task-list', key: 'tasks' } as const, [])
const closedOn = atom({ plugin: 'task-list', key: 'closedOn' } as const, null)
const plan = atom({ plugin: 'task-list', key: 'plan' } as const, null)
const cwd = atom({ plugin: 'task-list', key: 'cwd' } as const, null)
// The band folded to one line, for this session only: every new session starts expanded
const isMinimized = atom({ plugin: 'task-list', key: 'isMinimized' } as const, false)

const snapshot = (running: PlanView | null, list: readonly Task[]): string => JSON.stringify({ running, list })

// A tool call that may have written a superpowers ledger: superpowers appends to it from Bash
const touchesLedger = (input: unknown): boolean => /\.superpowers|progress\.md|sdd-workspace/.test(JSON.stringify(input))

const refreshPlan = async ($: EngineInterface): Promise<void> => {
  const dir = await read($, cwd)
  if (dir === null) {
    return
  }

  const running = await loadPlanView(
    {
      read: path => $.fs.read(path).catch(() => null),
      list: path => $.fs.list(path).catch(() => []),
      exists: path => $.fs.exists(path).catch(() => false),
    },
    dir,
    await $.clock.now(),
  )
  await update($, plan, () => running)
}

const MARK = { pending: '◻', in_progress: '◼', completed: '✔' } as const

const PANE = 'task-list'
const PANE_TITLE = 'Plan & tasks'

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
      name: 'task-tree',
      description: 'Show the whole superpowers plan tree (phases, plans, tasks, todos) in a pane',
    })
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

    await update($, cwd, () => e.cwd)
    await refreshPlan($)

    return next(e)
  })

  // A superpowers plan's progress lives in its ledger: read it again after a call that may have
  // written it, and at the end of every turn
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (touchesLedger(e)) {
      await refreshPlan($)
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    await refreshPlan($)

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

  on('command.run', { command: 'task-tree' }, async $ => {
    await refreshPlan($)
    await $.ui.open({ id: PANE, title: PANE_TITLE })

    return { text: `${PANE_TITLE} pane opened.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const view = await read($, plan)
    // The band follows a plan only while it runs; a finished one stays in the pane
    const running = view?.isRunning ? view : null
    const list = withoutPlanTodos(await read($, tasks), running)
    const done = list.filter(one => one.status === 'completed').length
    // A finished list is history, not current work, so it hides even while Claude keeps working
    const hasTodos = list.length > 0 && done < list.length

    // Closed by the person: hidden until the plan or the list changes
    const isClosed = (await read($, closedOn)) === snapshot(running, list)

    if (e.props.hasSurvey || (running === null && !hasTodos) || isClosed) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const active = list.find(one => one.status === 'in_progress')
    const minimized = await read($, isMinimized)
    const setMinimized = (value: boolean) => update($, isMinimized, () => value)
    // Minimized: one line naming where the work is; the todo in progress, else the next to do
    const current = active ?? list.find(one => one.status !== 'completed')
    const summary = minimized
      ? running === null
        ? `Todo (${current ? list.indexOf(current) + 1 : 0}/${list.length}) ${current?.subject ?? ''}`
        : breadcrumb(running)
      : running === null
        ? `${done}/${list.length} done${active?.activeForm ? ` · ${active.activeForm}…` : ''}`
        : `${MARK.in_progress} ${planSummary(running.name, running.tasks)}`

    return (
      <Box flexDirection="column">
        <Box key="head" flexDirection="row" justifyContent="space-between" columnGap={2}>
          <Text key="summary" bold={running !== null} dimColor={running === null} wrap="truncate-end">
            {summary}
          </Text>
          <Box key="actions" flexDirection="row" columnGap={2}>
            <Button key="details" label="Details" plain dimColor onPress={() => $.ui.open({ id: PANE, title: PANE_TITLE })} />
            {/* Minimize and close sit together at the right edge, as a window's controls do */}
            <Box key="window" flexDirection="row" columnGap={1}>
              {minimized ? (
                <Button key="restore" label="🗖" plain dimColor onPress={() => setMinimized(false)} />
              ) : (
                <Button key="minimize" label="–" plain dimColor onPress={() => setMinimized(true)} />
              )}
              <Button
                key="close"
                label="✕"
                role="dismiss"
                plain
                dimColor
                onPress={() => update($, closedOn, () => snapshot(running, list))}
              />
            </Box>
          </Box>
        </Box>
        {!minimized && (running === null ? todoLines($, e, list) : taskTree($, e, running.tasks, hasTodos ? list : []))}
      </Box>
    )
  })

  // The whole tree: every phase and plan; the running plan's phase with each plan's tasks, done and to do
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const view = await read($, plan)
    const list = withoutPlanTodos(await read($, tasks), view)

    if (view === null) {
      return (
        <Box flexDirection="column">
          <Text key="none" dimColor>
            No superpowers plan in this folder.
          </Text>
          {todoLines($, e, list)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {view.groups.map((group, index) => {
          const plansDone = group.plans.filter(row => row.status === 'completed').length
          const isCurrentGroup = group.plans.some(row => row.isCurrent)

          return (
            <Box key={`group-${index}`} flexDirection="column" marginBottom={1}>
              <Text key="head" bold>
                {group.phase === null ? 'Plans' : `Phase ${group.phase}`} · {plansDone}/{group.plans.length} plans done
              </Text>
              {group.plans.map((row, at) => (
                <Box key={`plan-${at}`} flexDirection="column" paddingLeft={2}>
                  <Text
                    key="line"
                    bold={row.isCurrent}
                    dimColor={row.status === 'completed'}
                    wrap="truncate-end"
                  >
                    {MARK[row.status]} {planSummary(row.name, row.tasks)}
                  </Text>
                  {isCurrentGroup && taskTree($, e, row.tasks, row.isCurrent ? list : [])}
                </Box>
              ))}
            </Box>
          )
        })}
      </Box>
    )
  })
}

// The plan's todos repeat its tasks (superpowers makes one per task): the tree shows them once
const withoutPlanTodos = (list: readonly Task[], view: PlanView | null): Task[] =>
  view === null ? [...list] : list.filter(task => !isPlanTodo(task.subject, view.tasks))

const planSummary = (name: string, planned: readonly PlanTask[]): string =>
  `${name} · ${planned.filter(task => task.status === 'completed').length}/${planned.length} tasks`

const todoLines = ($: EngineInterface, e: RenderInput, list: readonly Task[]) => {
  const { Text } = $.ui.resolve(e)

  return list.map(task => (
    <Text
      key={task.id}
      bold={task.status === 'in_progress'}
      dimColor={task.status === 'completed'}
      strikethrough={task.status === 'completed'}
    >
      {MARK[task.status]} {task.subject}
    </Text>
  ))
}

// A plan's tasks, the todos under the task in progress (after the tasks when none is)
const taskTree = ($: EngineInterface, e: RenderInput, planned: readonly PlanTask[], todos: readonly Task[]) => {
  const { Box, Text } = $.ui.resolve(e)
  const activeTask = planned.find(task => task.status === 'in_progress')
  const todoBox = todos.length > 0 && (
    <Box key="todos" flexDirection="column" paddingLeft={2}>
      {todoLines($, e, todos)}
    </Box>
  )

  return (
    <Box key="tasks" flexDirection="column" paddingLeft={2}>
      {planned.map(task => (
        <Box key={`task-${task.n}`} flexDirection="column">
          <Text
            key="line"
            bold={task.status === 'in_progress'}
            dimColor={task.status === 'completed'}
            wrap="truncate-end"
          >
            {MARK[task.status]} Task {task.n} {task.title}
            {task.step ? ` · ${task.step}` : ''}
          </Text>
          {task === activeTask && todoBox}
        </Box>
      ))}
      {activeTask === undefined && todoBox}
    </Box>
  )
}
