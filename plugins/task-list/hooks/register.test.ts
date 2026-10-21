import type { On, RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Files } from './sdd'
import { agentActivity, agentText, describeAction, tasksOfAgent } from './agents'
import { memoryFiles, NOW, PHASE_7_DISK, SDD } from './sdd.fixtures'

const SURFACES = ['desktop', 'terminal'] as const
const band = (isWorking: boolean) =>
  ({
    plugin: 'task-list',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking, maxRows: 20, bodyColumns: 80 } as never,
  }) as const

// Stands in for the engine beneath the plugins: its placeholder, drawn when no plugin draws a band
const engineBand = (on: On) =>
  on('ui.render', { component: 'AbovePrompt' }, async () => ({ type: 'engine', ref: 0 }) as RenderElement)

test('tracks TaskCreate / TaskUpdate and draws the checklist', async ($, on) => {
  engineBand(on)
  let next = 0
  on('tool.call', { tool: 'TaskCreate' }, async () => ({
    result: { task: { id: String(++next), subject: 'x' } },
  }))
  on('tool.call', { tool: 'TaskUpdate' }, async (_$, e) => ({
    result: { success: true, taskId: e.taskId, updatedFields: ['status'] },
  }))

  await $.tool.call({ tool: 'TaskCreate', subject: 'Write tests', description: 'd', activeForm: 'Writing tests' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Ship it', description: 'd' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Drop me', description: 'd' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '3', status: 'deleted' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...band(true), surface })
    const texts = await ui.findAll({ type: 'Text' })
    const lines = texts.map(one => one.text)
    expect(lines).toEqual(['0/2 done · Writing tests…', '◼ Write tests', '◻ Ship it'])
    expect(texts[1]?.props.bold).toBe(true)
  }
})

test('mirrors TodoWrite lists', async ($, on) => {
  engineBand(on)
  on('tool.call', { tool: 'TodoWrite' }, async (_$, e) => ({
    result: { oldTodos: [], newTodos: e.todos },
  }))

  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Plan', status: 'completed', activeForm: 'Planning' },
      { content: 'Build', status: 'in_progress', activeForm: 'Building' },
    ],
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...band(true), surface })
    const texts = await ui.findAll({ type: 'Text' })
    const lines = texts.map(one => one.text)
    expect(lines).toEqual(['1/2 done · Building…', '✔ Plan', '◼ Build'])
    expect(texts[1]?.props.strikethrough).toBe(true)
  }
})

test('steps aside once every task is done, working or not', async ($, on) => {
  on('tool.call', { tool: 'TodoWrite' }, async (_$, e) => ({
    result: { oldTodos: [], newTodos: e.todos },
  }))
  engineBand(on)

  await $.tool.call({
    tool: 'TodoWrite',
    todos: [{ content: 'Plan', status: 'completed', activeForm: 'Planning' }],
  })

  for (const surface of SURFACES) {
    const working = await $.ui.mount({ ...band(true), surface })
    expect((await working.findAll({ type: 'Text' })).map(one => one.text)).toEqual([])
    const idle = await $.ui.mount({ ...band(false), surface })
    expect((await idle.findAll({ type: 'Text' })).map(one => one.text)).toEqual([])
  }
})

test('/task-demo fills the band and /task-demo clear empties it', async ($, on) => {
  engineBand(on)

  await $.command.run({ command: 'task-demo', args: '', origin: 'user' } as never)
  const ui = await $.ui.mount({ ...band(false), surface: 'desktop' })
  expect((await ui.findAll({ type: 'Text' })).map(one => one.text)).toEqual([
    '1/4 done · Computing the response rate…',
    '✔ Read the responses screen',
    '◼ Compute the response rate',
    '◻ Add the KPI card',
    '◻ Write tests',
  ])

  await $.command.run({ command: 'task-demo', args: 'clear', origin: 'user' } as never)
  const cleared = await $.ui.mount({ ...band(false), surface: 'desktop' })
  expect((await cleared.findAll({ type: 'Text' })).map(one => one.text)).toEqual([])
})

test('the close button hides the band until the list changes', async ($, on) => {
  on('tool.call', { tool: 'TodoWrite' }, async (_$, e) => ({
    result: { oldTodos: [], newTodos: e.todos },
  }))
  engineBand(on)
  // A list of its own per surface, so one surface's close never carries into the next
  const write = (surface: (typeof SURFACES)[number], status: 'pending' | 'in_progress') =>
    $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'Plan', status: 'in_progress', activeForm: 'Planning' },
        { content: `Build for ${surface}`, status, activeForm: 'Building' },
      ],
    })
  const lines = async (surface: (typeof SURFACES)[number]) => {
    const ui = await $.ui.mount({ ...band(true), surface })

    return (await ui.findAll({ type: 'Text' })).map(one => one.text)
  }

  for (const surface of SURFACES) {
    await write(surface, 'pending')
    const ui = await $.ui.mount({ ...band(true), surface })
    expect((await ui.find({ key: 'close' }))?.props.role).toBe('dismiss')
    await ui.press({ key: 'close' })
    expect(await lines(surface)).toEqual([])

    // The same list written again stays closed; a changed one brings the band back
    await write(surface, 'pending')
    expect(await lines(surface)).toEqual([])
    await write(surface, 'in_progress')
    expect(await lines(surface)).toEqual(['0/2 done · Planning…', '◼ Plan', `◼ Build for ${surface}`])
  }
})

test('adds its own todo tool only where the built-in task tools are missing', async ($, on) => {
  const cases = [
    { tools: ['Read', 'Bash'], expected: ['todo_write'] },
    { tools: ['Read', 'TodoWrite'], expected: [] },
    { tools: ['Read', 'TaskCreate', 'TaskUpdate'], expected: [] },
  ]

  let tools: string[] = []
  let registered: string[] = []
  on('session.start', async (_$, e) => e)
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('tool.list', async () => ({ value: tools.map(name => ({ name, description: name, mcp: false })) }))
  on('tool.register', async (_$, e) => {
    registered.push(e.name)

    return { value: { tool: `mcp__task-list__${e.name}` } }
  })

  for (const one of cases) {
    tools = one.tools
    registered = []
    await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
    expect(registered).toEqual(one.expected)
  }
})

test('draws what its own todo tool writes and refuses a malformed list', async ($, on) => {
  engineBand(on)
  const written = await $.tool.call({
    tool: 'mcp__task-list__todo_write',
    todos: [
      { content: 'Plan', status: 'completed', activeForm: 'Planning' },
      { content: 'Build', status: 'in_progress', activeForm: 'Building' },
      { content: 'Ship', status: 'pending', activeForm: 'Shipping' },
    ],
  } as never)
  expect(written.result).toBe('Todo list updated: 1/3 done.')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...band(true), surface })
    expect((await ui.findAll({ type: 'Text' })).map(one => one.text)).toEqual([
      '1/3 done · Building…',
      '✔ Plan',
      '◼ Build',
      '◻ Ship',
    ])
  }

  const refused = await $.tool.call({
    tool: 'mcp__task-list__todo_write',
    todos: [{ content: 'Plan', status: 'done' }],
  } as never)
  expect(refused.deny).toContain('todos must be')
})

// Stands in for the engine's disk and session start, with superpowers' files on it
const superpowersSession = (on: On, files: Files) => {
  engineBand(on)
  on('session.start', async (_$, e) => e)
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('tool.list', async () => ({ value: [{ name: 'TodoWrite', description: 'todo', mcp: false }] }))
  on('clock.now', async () => ({ value: NOW }))
  on('fs.exists', async (_$, e) => ({ value: await files.exists(e.path) }))
  on('fs.list', async (_$, e) => ({ value: (await files.list(e.path)).map(entry => ({ ...entry, size: 0, isLink: false })) }) as never)
  on('fs.read', async (_$, e) => {
    const text = await files.read(e.path)
    if (text === null) {
      throw new Error(`ENOENT: ${e.path}`)
    }

    return { value: text }
  })
  on('tool.call', { tool: 'TodoWrite' }, async (_$, e) => ({ result: { oldTodos: [], newTodos: e.todos } }))
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
}

const pane = { plugin: 'task-list', component: 'Pane', requestId: 'task-list', props: { title: 'Plan & tasks', isFocused: false, bodyColumns: 60 } as never } as const

// Superpowers' own todo per task (left out) beside the work inside Task 2
const TODOS = [
  { content: 'Task 2: packages/api', status: 'in_progress', activeForm: 'Building packages/api' },
  { content: 'Run the type generation', status: 'in_progress', activeForm: 'Running the type generation' },
  { content: 'Wire the session client', status: 'pending', activeForm: 'Wiring the session client' },
] as const

const PLAN_3_TASKS = [
  '✔ Task 1 Workspace, shared tooling and packages/ui',
  '◼ Task 2 packages/api — OpenAPI types and the session-aware client · fix round 1',
  '◼ Run the type generation',
  '◻ Wire the session client',
  '◻ Task 3 The three app shells',
]

test('the band shows the running plan with the todos under the task in progress', async ($, on) => {
  superpowersSession(on, memoryFiles(PHASE_7_DISK))
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'TodoWrite', todos: [...TODOS] })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...band(true), surface })
    expect((await ui.findAll({ type: 'Text' })).map(one => one.text)).toEqual([
      '◼ Plan 3 — Frontend Foundation · 1/3 tasks',
      ...PLAN_3_TASKS,
    ])
    expect((await ui.findAll({ type: 'Button' })).map(one => one.key)).toEqual(['details', 'minimize', 'close'])
  }
})

test('the band follows the ledger as superpowers appends to it', async ($, on) => {
  const disk = { ...PHASE_7_DISK }
  superpowersSession(on, memoryFiles(disk))
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const ledger = `${SDD}/2026-10-13-phase7-plan3-frontend/progress.md`
  const lines = async () => (await (await $.ui.mount({ ...band(true), surface: 'desktop' })).findAll({ type: 'Text' })).map(one => one.text)

  disk[ledger] = { text: `${disk[ledger]?.text}\nTask 2: complete (a..b)\nTask 3: dispatched (sonnet)`, mtimeMs: 400 }
  // A command that doesn't touch the ledger reads nothing again
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect((await lines())[0]).toBe('◼ Plan 3 — Frontend Foundation · 1/3 tasks')

  await $.tool.call({ tool: 'Bash', command: 'echo "Task 3: dispatched" >> $W/progress.md' } as never)
  expect(await lines()).toEqual([
    '◼ Plan 3 — Frontend Foundation · 2/3 tasks',
    '✔ Task 1 Workspace, shared tooling and packages/ui',
    '✔ Task 2 packages/api — OpenAPI types and the session-aware client',
    '◼ Task 3 The three app shells · implementing',
  ])

  // Every task complete: the plan leaves the band
  disk[ledger] = { text: `${disk[ledger]?.text}\nTask 3: complete (b..c)`, mtimeMs: 500 }
  await $.tool.call({ tool: 'Bash', command: 'echo "Task 3: complete" >> $W/progress.md' } as never)
  expect(await lines()).toEqual([])
})

test('the pane shows every phase, the running phase down to its tasks and todos', async ($, on) => {
  superpowersSession(on, memoryFiles(PHASE_7_DISK))
  const opened: string[] = []
  on('ui.open', async (_$, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } } as never
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'TodoWrite', todos: [...TODOS] })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane, surface })
    expect((await ui.findAll({ type: 'Text' })).map(one => one.text)).toEqual([
      'Phase 5 · 1/1 plans done',
      '✔ Alert Emails · 1/1 tasks',
      'Phase 7 · 2/4 plans done',
      '✔ Plan 1 — Admin Access · 2/2 tasks',
      '✔ Task 1 Roles',
      '✔ Task 2 Audit log',
      '✔ Plan 2 — User Tools · 1/1 tasks',
      '✔ Task 1 Blocking',
      '◼ Plan 3 — Frontend Foundation · 1/3 tasks',
      ...PLAN_3_TASKS,
      '◻ Plan 4 — Later · 0/1 tasks',
      '◻ Task 1 Next',
    ])

    // Details on the band opens it
    opened.length = 0
    const strip = await $.ui.mount({ ...band(true), surface })
    await strip.press({ key: 'details' })
    expect(opened).toEqual(['task-list'])
  }
})

const BREADCRUMB = 'Phase 7 (2/2) \\ Plan (3/4) \\ Task (2/3) packages/api — OpenAPI types and the session-aware client · fix round 1'

test('the minimize button folds the band to one breadcrumb line until restored', async ($, on) => {
  superpowersSession(on, memoryFiles(PHASE_7_DISK))
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'TodoWrite', todos: [...TODOS] })
  const draw = async (surface: (typeof SURFACES)[number]) => {
    const ui = await $.ui.mount({ ...band(true), surface })

    return {
      ui,
      lines: (await ui.findAll({ type: 'Text' })).map(one => one.text),
      buttons: (await ui.findAll({ type: 'Button' })).map(one => one.key),
    }
  }

  for (const surface of SURFACES) {
    await (await draw(surface)).ui.press({ key: 'minimize' })
    const minimized = await draw(surface)
    expect(minimized.lines).toEqual([BREADCRUMB])
    expect(minimized.buttons).toEqual(['details', 'restore', 'close'])

    // It stays folded as the band redraws
    expect((await draw(surface)).lines).toEqual([BREADCRUMB])

    await minimized.ui.press({ key: 'restore' })
    const restored = await draw(surface)
    expect(restored.lines).toEqual(['◼ Plan 3 — Frontend Foundation · 1/3 tasks', ...PLAN_3_TASKS])
    expect(restored.buttons).toEqual(['details', 'minimize', 'close'])
  }
})

test('a minimized todo list shows the todo in progress and its place', async ($, on) => {
  superpowersSession(on, memoryFiles({}))
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Plan', status: 'completed', activeForm: 'Planning' },
      { content: 'Build', status: 'in_progress', activeForm: 'Building' },
      { content: 'Ship', status: 'pending', activeForm: 'Shipping' },
    ],
  })

  await (await $.ui.mount({ ...band(true), surface: 'desktop' })).press({ key: 'minimize' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...band(true), surface })
    expect((await ui.findAll({ type: 'Text' })).map(one => one.text)).toEqual(['Todo (2/3) Build'])
  }
})

// Another mod's band (skill-usage) beneath this one: plugins of one tier nest in no fixed order,
// so this mod must keep what lies beneath when it draws
const OTHER_BAND = {
  name: 'other-band',
  tier: 'append',
  register: (on: On) => {
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return h(Text, {}, 'other band') as RenderElement
    })
  },
} as const

test('the band keeps another mod band drawn beneath it, under the task list', { plugins: [OTHER_BAND] }, async ($, on) => {
  on('tool.call', { tool: 'TodoWrite' }, async (_$, e) => ({ result: { oldTodos: [], newTodos: e.todos } }))
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Plan', status: 'completed', activeForm: 'Planning' },
      { content: 'Build', status: 'in_progress', activeForm: 'Building' },
    ],
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...band(true), surface })
    expect((await ui.findAll({ type: 'Text' })).map(one => one.text)).toEqual([
      '1/2 done · Building…',
      '✔ Plan',
      '◼ Build',
      'other band',
    ])
    // Each band framed like the prompt box, so the two read apart
    const frames = (await ui.findAll({ type: 'Box' })).filter(box => box.props.borderStyle === 'round')
    expect(frames.map(box => box.props.borderColor)).toEqual(['promptBorder', 'promptBorder'])
  }
})

test('a task the ledger defers shows on hold', async ($, on) => {
  const disk = {
    ...PHASE_7_DISK,
    [`${SDD}/2026-10-13-phase7-plan3-frontend/progress.md`]: {
      text: [
        '# SDD ledger — plan: docs/superpowers/plans/2026-10-13-phase7-plan3-frontend.md',
        'Task 1: complete (a..b)',
        'Task 2 review: spec ❌ / Changes needed',
        'Ruling: Task 2 I1 deferred to after Task 3',
        'Task 3: dispatched (BASE frontend 3d45ecc)',
      ].join('\n'),
      mtimeMs: 300,
    },
  }
  superpowersSession(on, memoryFiles(disk))
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...band(true), surface })
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts.map(one => one.text)).toEqual([
      '◼ Plan 3 — Frontend Foundation · 1/3 tasks',
      '✔ Task 1 Workspace, shared tooling and packages/ui',
      '◐ Task 2 packages/api — OpenAPI types and the session-aware client · review · on hold',
      '◼ Task 3 The three app shells · implementing',
    ])
    // Only the task being worked on is bold
    expect(texts.map(one => one.props.bold)).toEqual([true, false, false, true])
  }
})

// Agents beside the plan: a session whose engine starts, lists and runs them, on a clock the test moves
const agentSession = async ($: Engine, on: On) => {
  const statuses = new Map<string, string>()
  const clock = mock.clock(on, { now: NOW })
  let next = 0
  engineBand(on)
  on('session.start', async (_$, e) => e)
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('tool.list', async () => ({ value: [{ name: 'TodoWrite', description: 'todo', mcp: false }] }))
  on('fs.exists', async (_$, e) => ({ value: await memoryFiles(PHASE_7_DISK).exists(e.path) }))
  on('fs.list', async (_$, e) => ({ value: (await memoryFiles(PHASE_7_DISK).list(e.path)).map(entry => ({ ...entry, size: 0, isLink: false })) }) as never)
  on('fs.read', async (_$, e) => {
    const text = await memoryFiles(PHASE_7_DISK).read(e.path)
    if (text === null) {
      throw new Error(`ENOENT: ${e.path}`)
    }

    return { value: text }
  })
  on('agent.spawn', async () => {
    const agentId = `agent-${++next}`
    statuses.set(agentId, 'running')

    return { model: 'claude-sonnet-5-5', agentId }
  })
  on('agent.list', async () => ({
    value: [...statuses].map(([id, status]) => ({ id, description: id, type: 'general-purpose', status })),
  }) as never)
  // `./run test` takes a minute, like a long suite
  on('tool.call', async (_$, e) => {
    if ((e as { command?: string }).command === './run test') {
      await clock.sleep(60_000)
    }

    return { result: 'ok' } as never
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  return { statuses, clock }
}

const spawnAgent = async ($: Engine, description: string): Promise<string> =>
  ((await $.agent.spawn({ prompt: 'do it', description } as never)) as { agentId?: string }).agentId ?? ''

const agentActs = ($: Engine, agentId: string, input: Record<string, unknown>) => $.tool.call({ ...input, agentId } as never)

const shown = async ($: Engine, surface: (typeof SURFACES)[number]) =>
  (await (await $.ui.mount({ ...band(true), surface })).findAll({ type: 'Text' })).map(one => one.text)

test('an agent working on a plan task shows under that task, others under „Other agents“', async ($, on) => {
  const { clock } = await agentSession($, on)
  const builder = await spawnAgent($, 'Plan 3 Task 2: fix round builder')
  const other = await spawnAgent($, 'Investigate the flaky e2e')
  await clock.advance(5 * 60_000)
  await agentActs($, builder, { tool: 'Bash', command: 'npx vitest run apps/client' })
  await agentActs($, other, { tool: 'Read', file_path: '/repo/e2e/shots-lib.ts' })
  await clock.advance(10_000)

  for (const surface of SURFACES) {
    const lines = await shown($, surface)
    const at = (text: string) => lines.findIndex(line => line.includes(text))
    // Under Task 2, before Task 3
    expect(at('fix round builder · running 5 min · Bash: npx vitest run apps/client · 10 s ago')).toBeGreaterThan(at('Task 2 packages/api'))
    expect(at('fix round builder')).toBeLessThan(at('Task 3 The three app shells'))
    // The unmatched agent at the bottom
    expect(at('Other agents')).toBeGreaterThan(at('Task 3 The three app shells'))
    expect(lines[lines.length - 1]).toContain('Investigate the flaky e2e · running 5 min · Read …/e2e/shots-lib.ts · 10 s ago')
  }
})

test('describeAction names a Bash call by its description, else its command past the opening cd', async () => {
  const cases: readonly [Record<string, unknown>, string][] = [
    [{ command: 'cd /home/kosio/Projects/poevtini && ./run test', description: 'Run full backend test suite' }, 'Bash: Run full backend test suite'],
    [{ command: 'cd /home/kosio/Projects/poevtini/repositories/poevtini-backend && cd tests; php bin/phpunit --filter Referral' }, 'Bash: php bin/phpunit --filter Referral'],
    [{ command: "python3 - <<'EOF'\nprint(1)\nEOF" }, "Bash: python3 - <<'EOF'"],
  ]
  for (const [input, shown] of cases) {
    expect(describeAction('Bash', input)).toBe(shown)
  }
})

test('a task an agent works on shows in progress before its ledger says so', async ($, on) => {
  await agentSession($, on)
  const before = (await shown($, 'terminal')).find(line => line.includes('Task 3 The three app shells')) ?? ''
  expect(before).toContain('◻ Task 3')

  await spawnAgent($, 'Plan 3 Task 3: shells builder')
  const lines = await shown($, 'terminal')
  expect(lines.find(line => line.includes('Task 3 The three app shells'))).toContain('◼ Task 3')
  expect(lines.some(line => line.includes('shells builder · running 0 min'))).toBe(true)
})

test('an agent on a range of tasks works on each of them and shows once, under the first', async ($, on) => {
  await agentSession($, on)
  await spawnAgent($, 'Review Plan 3 tasks 1–3')
  const lines = await shown($, 'terminal')
  const at = (text: string) => lines.findIndex(line => line.includes(text))

  expect(lines.find(line => line.includes('Task 3 The three app shells'))).toContain('◼ Task 3')
  expect(lines.filter(line => line.includes('Review Plan 3 tasks 1–3'))).toHaveLength(1)
  expect(at('Review Plan 3 tasks 1–3')).toBeGreaterThan(at('Task 1 '))
  expect(at('Review Plan 3 tasks 1–3')).toBeLessThan(at('Task 2 '))
  expect(lines.some(line => line.includes('Other agents'))).toBe(false)
})

test('tasksOfAgent reads single tasks, ranges and lists, and skips another plan', async () => {
  const tasks = [1, 2, 3, 4, 5].map(n => ({ n, title: `T${n}`, status: 'pending' as const }))
  const cases: [string, string, number[]][] = [
    ['Plan 10 Task 4: referral invites', 'Plan 10 — Growth', [4]],
    ['Review Plan 11 tasks 1–4', 'Watch archive and search', [1, 2, 3, 4]],
    ['Plan 11 Tasks 1-3: search, archive (backend)', 'Watch archive and search', [1, 2, 3]],
    ['Fix Tasks 2, 3 and 5', 'Watch archive and search', [2, 3, 5]],
    ['Tasks 4 to 9', 'Watch archive and search', [4, 5]],
    ['Plan 9 Task 2 builder', 'Plan 10 — Growth', []],
    ['Investigate the flaky e2e', 'Plan 10 — Growth', []],
  ]
  for (const [description, plan, expected] of cases) {
    expect(tasksOfAgent(description, plan, tasks)).toEqual(expected)
  }
})

test('an agent inside a long tool call is busy, not quiet, until the call returns', async ($, on) => {
  const { clock } = await agentSession($, on)
  const builder = await spawnAgent($, 'Plan 3 Task 2: fix round builder')
  const suite = agentActs($, builder, { tool: 'Bash', command: './run test' })
  // Past the 30 s an agent counts as working after its last step: the running call keeps it spinning
  await clock.advance(40_000)
  const busy = (await shown($, 'terminal')).find(line => line.includes('fix round builder')) ?? ''
  expect(busy).toContain('Bash: ./run test · 40 s so far')
  expect(await (await $.ui.mount({ ...band(true), surface: 'desktop' })).findAll({ type: 'Svg' })).toHaveLength(1)

  // However long it runs, it never reads as quiet
  const inSuite = { id: builder, description: 'builder', startedAt: 0, lastAt: 0, lastAction: 'Bash: ./run test', toolsRunning: 1 }
  expect(agentText(inSuite, 7 * 60_000)).toBe('builder · running 7 min · Bash: ./run test · 7 min so far')
  expect(agentActivity(inSuite, 7 * 60_000, 'builder')).toBe('builder · Bash: ./run test · 7 min so far')

  // Back from the call, the quiet counts from its end
  await clock.advance(25_000)
  await suite
  const done = (await shown($, 'terminal')).find(line => line.includes('fix round builder')) ?? ''
  expect(done).toContain('Bash: ./run test · 5 s ago')
  expect(done).not.toContain('no activity')
})

test('an agent line spins while it works, turns amber when quiet for 5 minutes and leaves when finished', async ($, on) => {
  const { statuses, clock } = await agentSession($, on)
  const builder = await spawnAgent($, 'Plan 3 Task 2: fix round builder')
  await agentActs($, builder, { tool: 'Edit', file_path: '/repo/packages/api/src/session.ts' })

  const desktop = await $.ui.mount({ ...band(true), surface: 'desktop' })
  expect(await desktop.findAll({ type: 'Svg' })).toHaveLength(1)
  const spinning = (await shown($, 'terminal')).find(line => line.includes('fix round builder')) ?? ''
  expect(spinning).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /)

  await clock.advance(7 * 60_000)
  const ui = await $.ui.mount({ ...band(true), surface: 'desktop' })
  const stuck = (await ui.findAll({ type: 'Text' })).find(one => one.text.includes('fix round builder'))
  expect(stuck?.text).toContain('no activity for 7 min')
  expect(stuck?.props.color).toBe('warning')

  statuses.set(builder, 'completed')
  await clock.advance(15_000)
  expect((await shown($, 'desktop')).join('\n')).not.toContain('fix round builder')
})

test('with no plan running the band still shows the agents', async ($, on) => {
  const statuses = new Map<string, string>()
  const clock = mock.clock(on, { now: NOW })
  engineBand(on)
  on('session.start', async (_$, e) => e)
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('tool.list', async () => ({ value: [{ name: 'TodoWrite', description: 'todo', mcp: false }] }))
  on('agent.spawn', async () => {
    statuses.set('agent-1', 'running')

    return { model: 'claude-sonnet-5-5', agentId: 'agent-1' }
  })
  on('agent.list', async () => ({ value: [...statuses].map(([id, status]) => ({ id, description: id, type: 'general-purpose', status })) }) as never)
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.session.start({ cwd: '/elsewhere', surface: 'desktop', isInteractive: true })
  await spawnAgent($, 'Investigate the flaky e2e')
  await clock.advance(1_000)

  for (const surface of SURFACES) {
    expect((await shown($, surface)).join('\n')).toContain('Investigate the flaky e2e · running 0 min')
  }
})

test('the folded band spins while an agent works', async ($, on) => {
  await agentSession($, on)
  const builder = await spawnAgent($, 'Plan 3 Task 2: fix round builder')
  await agentActs($, builder, { tool: 'Bash', command: 'ls' })
  await (await $.ui.mount({ ...band(true), surface: 'desktop' })).press({ key: 'minimize' })

  expect(await (await $.ui.mount({ ...band(true), surface: 'desktop' })).findAll({ type: 'Svg' })).toHaveLength(1)
  expect((await shown($, 'terminal'))[0]).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Phase 7/)
})

test('the folded band shows what the latest active agent is doing, and how many others run', async ($, on) => {
  const { clock } = await agentSession($, on)
  const builder = await spawnAgent($, 'Plan 3 Task 2: fix round builder')
  const other = await spawnAgent($, 'Investigate the flaky e2e')
  await agentActs($, other, { tool: 'Read', file_path: '/repo/e2e/shots-lib.ts' })
  await clock.advance(2_000)
  await agentActs($, builder, { tool: 'Edit', file_path: '/repo/packages/api/src/session.ts' })
  await clock.advance(5_000)
  await (await $.ui.mount({ ...band(true), surface: 'desktop' })).press({ key: 'minimize' })

  for (const surface of SURFACES) {
    const folded = (await shown($, surface))[0] ?? ''
    expect(folded).toContain('Task (2/3) packages/api — OpenAPI types and the session-aware client · fix round 1')
    // The builder acted last, on the breadcrumb's task: named by its role
    expect(folded).toMatch(/ — fix round builder · Edit …\/src\/session\.ts · \d+ s ago \(\+1 agent\)$/)
  }
})
