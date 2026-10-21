import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, RenderInput, RenderElement } from 'claude-code'

import type { PlanTask, PlanView, Task, Todo, TrackedAgent } from '../types'
import {
  agentActivity,
  agentText,
  ALIVE,
  describeAction,
  GRACE_MS,
  isActive,
  isStuck,
  roleUnderTask,
  SPINNER,
  SPINNER_SVG,
  taskOfAgent,
} from './agents'
import { breadcrumb, isPlanTodo, loadPlanView } from './sdd'

const tasks = atom({ plugin: 'task-list', key: 'tasks' } as const, [])
const closedOn = atom({ plugin: 'task-list', key: 'closedOn' } as const, null)
const plan = atom({ plugin: 'task-list', key: 'plan' } as const, null)
const cwd = atom({ plugin: 'task-list', key: 'cwd' } as const, null)
// The band folded to one line, for this session only: every new session starts expanded
const isMinimized = atom({ plugin: 'task-list', key: 'isMinimized' } as const, false)
const agents = atom({ plugin: 'task-list', key: 'agents' } as const, [])
const clock = atom({ plugin: 'task-list', key: 'clock' } as const, 0)
const frame = atom({ plugin: 'task-list', key: 'frame' } as const, 0)

// The clock is read every TICK_MS (for „9 s ago“), the engine's agent list every LIST_EVERY ticks
const TICK_MS = 5_000
const LIST_EVERY = 3
const SPIN_MS = 250

const snapshot = (running: PlanView | null, list: readonly Task[], followed: readonly TrackedAgent[]): string =>
  JSON.stringify({ running, list, agents: followed.map(agent => agent.id) })

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

const MARK = { pending: '◻', in_progress: '◼', completed: '✔', on_hold: '◐', unreviewed: '◐' } as const

let spinner: { cancel: () => void } | null = null

// The terminal spinner steps only while some agent is active
const keepSpinning = async ($: EngineInterface): Promise<void> => {
  const at = await $.clock.now()
  const isWorking = (await read($, agents)).some(agent => isActive(agent, at))
  if (isWorking && spinner === null) {
    spinner = $.clock.every(SPIN_MS, () => {
      void update($, frame, step => step + 1)
      void keepSpinning($)
    })
  }
  if (!isWorking && spinner !== null) {
    spinner.cancel()
    spinner = null
  }
}

// The engine's list says which agents still run: finished, failed, stopped and waiting ones leave. Agents are added
// only when this mod sees them start or act, never from the list alone (it keeps finished agents for a while)
const syncAgents = async ($: EngineInterface, at: number, listed: readonly AgentInfo[]): Promise<void> => {
  const statusOf = new Map(listed.map(agent => [agent.id, agent.status]))
  await update($, agents, followed =>
    followed.filter(agent => {
      const status = statusOf.get(agent.id)

      return status === undefined ? at - agent.startedAt < GRACE_MS : ALIVE.includes(status)
    }),
  )
}

const refreshAgents = async ($: EngineInterface): Promise<void> => {
  const at = await $.clock.now()
  await syncAgents($, at, await $.agent.list().catch(() => []))
  await update($, clock, () => at)
  await keepSpinning($)
}

let ticks = 0

const tick = async ($: EngineInterface): Promise<void> => {
  ticks += 1
  if (ticks % LIST_EVERY === 0) {
    await refreshAgents($)
    return
  }
  const at = await $.clock.now()
  await update($, clock, () => at)
}

const followAgent = async ($: EngineInterface, agentId: string, description: string | null, action: string | null): Promise<void> => {
  const at = await $.clock.now()
  const known = (await read($, agents)).find(agent => agent.id === agentId)
  // An agent started before this mod loaded joins at its first action, named as the engine lists it
  const name = description ?? known?.description ?? (await $.agent.list().catch(() => [])).find(agent => agent.id === agentId)?.description ?? 'Agent'
  await update($, agents, followed => [
    ...followed.filter(agent => agent.id !== agentId),
    known && description === null
      ? { ...known, lastAt: at, lastAction: action ?? known.lastAction, toolsRunning: (known.toolsRunning ?? 0) + (action === null ? 0 : 1) }
      : { id: agentId, description: name, startedAt: known?.startedAt ?? at, lastAt: at, lastAction: action, toolsRunning: action === null ? 0 : 1 },
  ])
  await update($, clock, () => at)
  await keepSpinning($)
}

// The agent's tool call came back: that is activity too, and the quiet starts from here
const finishTool = async ($: EngineInterface, agentId: string): Promise<void> => {
  const at = await $.clock.now()
  await update($, agents, followed =>
    followed.map(agent =>
      agent.id === agentId ? { ...agent, lastAt: at, toolsRunning: Math.max(0, (agent.toolsRunning ?? 0) - 1) } : agent,
    ),
  )
  await update($, clock, () => at)
  await keepSpinning($)
}

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
    await refreshAgents($)
    $.clock.every(TICK_MS, () => void tick($))

    return next(e)
  })

  // The background agents: each one started, and each tool call one makes (below; it carries the agent's id)
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.agentId) {
      await followAgent($, started.agentId, e.description, null)
    }

    return started
  })

  // A tool call made inside a background agent is that agent's latest action. A superpowers plan's progress lives
  // in its ledger: read it again after a call that may have written it, and at the end of every turn
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      await followAgent($, agentId, null, describeAction(e.tool, e as unknown as Record<string, unknown>))
    }
    const ran = await next(e).finally(() => (agentId ? finishTool($, agentId) : undefined))
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
    const followed = await read($, agents)

    // Closed by the person: hidden until the plan, the list or the agents change
    const isClosed = (await read($, closedOn)) === snapshot(running, list, followed)

    if (e.props.hasSurvey || (running === null && !hasTodos && followed.length === 0) || isClosed) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const at = await read($, clock)
    const art = await agentArt($, e)
    const isWorking = followed.some(agent => isActive(agent, at))
    const byTask = agentsByTask(followed, running)
    const shown = running === null ? null : withAgentsAtWork(running, byTask.of)
    const active = list.find(one => one.status === 'in_progress')
    const minimized = await read($, isMinimized)
    const setMinimized = (value: boolean) => update($, isMinimized, () => value)
    // Minimized: one line naming where the work is; the todo in progress, else the next to do
    const current = active ?? list.find(one => one.status !== 'completed')
    const summary = minimized
      ? shown === null
        ? hasTodos
          ? `Todo (${current ? list.indexOf(current) + 1 : 0}/${list.length}) ${current?.subject ?? ''}`
          : `${followed.length} agent${followed.length === 1 ? '' : 's'} running`
        : breadcrumb(shown)
      : shown === null
        ? hasTodos
          ? `${done}/${list.length} done${active?.activeForm ? ` · ${active.activeForm}…` : ''}`
          : 'Agents'
        : `${MARK.in_progress} ${planSummary(shown.name, shown.tasks)}`
    // While an agent works the folded line spins in front
    const foldedSpinner = minimized && isWorking ? art.marker(true) : ''
    // Folded, the line also says what the latest active agent is doing, and how many others run
    const latest = [...followed].sort((a, b) => b.lastAt - a.lastAt)[0]
    const crumbTask = shown?.tasks.find(task => task.status === 'in_progress') ?? shown?.tasks.find(task => task.status === 'pending')
    const others = followed.length - 1
    const foldedActivity =
      minimized && latest
        ? ` — ${agentActivity(latest, at, crumbTask && byTask.of(crumbTask.n).includes(latest) ? roleUnderTask(latest.description) : latest.description)}${
            others > 0 ? ` (+${others} agent${others === 1 ? '' : 's'})` : ''
          }`
        : ''
    const unmatched = followed.filter(agent => !byTask.matched.has(agent.id))

    const mine = (
      <Box key="task-list" flexDirection="column">
        <Box key="head" flexDirection="row" justifyContent="space-between" columnGap={2}>
          <Box key="title" flexDirection="row" columnGap={1} flexShrink={1} minWidth={0}>
            {minimized && isWorking && art.image('head-spinner')}
            <Text key="summary" bold={running !== null} dimColor={running === null} wrap="truncate-end">
              {foldedSpinner}
              {summary}
              {foldedActivity}
            </Text>
          </Box>
          {/* Never squeezed: a long folded line truncates instead of pushing the buttons out */}
          <Box key="actions" flexDirection="row" columnGap={2} flexShrink={0}>
            <Button key="details" label="Details" plain dimColor onPress={() => $.ui.open({ id: PANE, title: PANE_TITLE })} />
            {/* Minimize and close sit together at the right edge, as a window's controls do */}
            <Box key="window" flexDirection="row" columnGap={1}>
              {minimized ? (
                <Button key="restore" label="□" plain dimColor onPress={() => setMinimized(false)} />
              ) : (
                <Button key="minimize" label="–" plain dimColor onPress={() => setMinimized(true)} />
              )}
              <Button
                key="close"
                label="×"
                role="dismiss"
                plain
                dimColor
                onPress={() => update($, closedOn, () => snapshot(running, list, followed))}
              />
            </Box>
          </Box>
        </Box>
        {!minimized &&
          (shown === null
            ? todoLines($, e, hasTodos ? list : [])
            : taskTree($, e, shown.tasks, hasTodos ? list : [], n => agentLines($, e, byTask.of(n), at, art, true)))}
        {!minimized && unmatched.length > 0 && (
          <Box key="other-agents" flexDirection="column" paddingLeft={running === null && !hasTodos ? 0 : 2}>
            {(running !== null || hasTodos) && (
              <Text key="other-agents-title" dimColor>
                Other agents
              </Text>
            )}
            {agentLines($, e, unmatched, at, art, false)}
          </Box>
        )}
      </Box>
    )

    // Plugins of one tier nest in no fixed order: another mod's band beneath this one (skill-usage)
    // stays, under the task list; the engine's own placeholder is left out
    const below = await next(e)
    if (below.type === 'engine') {
      return mine
    }

    // Bands stacked: each framed like the prompt box, a row apart, so they read apart; a stack another mod already
    // framed (key band-stack) is joined rather than framed again
    const stacked = (below as { props?: { key?: string } }).props?.key === 'band-stack'

    return (
      <Box key="band-stack" flexDirection="column" rowGap={1}>
        <Box key="task-list-frame" flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={1}>
          {mine}
        </Box>
        {stacked ? (below as { children?: RenderElement[] }).children : (
          <Box key="upper" flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={1}>
            {below}
          </Box>
        )}
      </Box>
    )
  })

  // The whole tree: every phase and plan; the running plan's phase with each plan's tasks, done and to do
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const view = await read($, plan)
    const list = withoutPlanTodos(await read($, tasks), view)
    const followed = await read($, agents)
    const at = await read($, clock)
    const art = await agentArt($, e)
    const byTask = agentsByTask(followed, view)

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
                    {row.status === 'on_hold' ? ' · left open' : ''}
                  </Text>
                  {isCurrentGroup &&
                    taskTree($, e, row.tasks, row.isCurrent ? list : [], n =>
                      row.isCurrent ? agentLines($, e, byTask.of(n), at, art, true) : [],
                    )}
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

// A plan's tasks, each with the agents working on it, and the todos under the task in progress (after the tasks when
// none is)
const taskTree = (
  $: EngineInterface,
  e: RenderInput,
  planned: readonly PlanTask[],
  todos: readonly Task[],
  agentsUnder: (n: number) => ReturnType<typeof agentLines>,
) => {
  const { Box, Text } = $.ui.resolve(e)
  const activeTask = planned.find(task => task.status === 'in_progress')
  const todoBox = todos.length > 0 && (
    <Box key="todos" flexDirection="column" paddingLeft={2}>
      {todoLines($, e, todos)}
    </Box>
  )

  return (
    <Box key="tasks" flexDirection="column" paddingLeft={2}>
      {planned.map(task => {
        const working = agentsUnder(task.n)
        // A task with an agent on it (its implementer, or the reviewer of an unreviewed one) is being worked on
        const status = task.status !== 'completed' && working.length > 0 ? 'in_progress' : task.status

        return (
          <Box key={`task-${task.n}`} flexDirection="column">
            <Text key="line" bold={status === 'in_progress'} dimColor={status === 'completed' || status === 'unreviewed'} wrap="truncate-end">
              {MARK[status]} Task {task.n} {task.title}
              {status === 'unreviewed' ? ' · implemented, not reviewed' : task.step ? ` · ${task.step}` : ''}
              {status === 'on_hold' ? ' · on hold' : ''}
            </Text>
            {working.length > 0 && (
              <Box key="agents" flexDirection="column" paddingLeft={2}>
                {working}
              </Box>
            )}
            {task === activeTask && todoBox}
          </Box>
        )
      })}
      {activeTask === undefined && todoBox}
    </Box>
  )
}

// How a working agent's marker is drawn: an animated image where the surface has one, a text spinner stepped by the
// clock in the terminal; a quiet agent gets a still dot
const agentArt = async ($: EngineInterface, e: RenderInput) => {
  const table = $.ui.resolve(e)
  const svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : null
  const step = svg === null ? await read($, frame) : 0

  return {
    marker: (isWorking: boolean): string => (isWorking ? (svg === null ? `${SPINNER[step % SPINNER.length]} ` : '') : '◦ '),
    image: (key: string) => svg !== null && h(svg, { key, source: SPINNER_SVG, alt: 'working', width: 12, height: 12, isInteractive: true }),
  }
}

// Agents by the plan task they work on, from their descriptions; the rest are no task's
// A task with an agent on it is being worked on, whatever its ledger says yet: in the tree and the folded line
const withAgentsAtWork = (view: PlanView, agentsOf: (n: number) => readonly TrackedAgent[]): PlanView => ({
  ...view,
  tasks: view.tasks.map(task =>
    task.status !== 'completed' && task.status !== 'in_progress' && agentsOf(task.n).length > 0 ? { ...task, status: 'in_progress' as const } : task,
  ),
})

const agentsByTask = (followed: readonly TrackedAgent[], view: PlanView | null) => {
  const taskOf = new Map(
    followed.map(agent => [agent.id, view === null ? null : taskOfAgent(agent.description, view.name, view.tasks)]),
  )

  return {
    matched: new Set(followed.filter(agent => taskOf.get(agent.id) != null).map(agent => agent.id)),
    of: (n: number) => followed.filter(agent => taskOf.get(agent.id) === n),
  }
}

// One line per agent: its spinner or dot, its name (its role, under its task), how long it has run, its latest action
// and how long ago; amber once quiet for 5 minutes
const agentLines = (
  $: EngineInterface,
  e: RenderInput,
  list: readonly TrackedAgent[],
  at: number,
  art: Awaited<ReturnType<typeof agentArt>>,
  isUnderTask: boolean,
) => {
  const { Box, Text } = $.ui.resolve(e)

  return list.map(agent => {
    const working = isActive(agent, at)

    return (
      <Box key={`agent-${agent.id}`} flexDirection="row" columnGap={1}>
        {working && art.image('spinner')}
        <Text key="line" color={isStuck(agent, at) ? 'warning' : undefined} wrap="truncate-end">
          {art.marker(working)}
          {agentText(agent, at, isUnderTask ? roleUnderTask(agent.description) : agent.description)}
        </Text>
      </Box>
    )
  })
}
