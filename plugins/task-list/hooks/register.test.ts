import type { On, RenderElement } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import type { Files } from './sdd'
import { memoryFiles, NOW, PHASE_7_DISK, SDD } from './sdd.fixtures'

const SURFACES = ['desktop', 'terminal'] as const
const band = (isWorking: boolean) =>
  ({
    plugin: 'task-list',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking, maxRows: 20, bodyColumns: 80 } as never,
  }) as const

test('tracks TaskCreate / TaskUpdate and draws the checklist', async ($, on) => {
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
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return h(Text, {}, 'engine band') as RenderElement
  })

  await $.tool.call({
    tool: 'TodoWrite',
    todos: [{ content: 'Plan', status: 'completed', activeForm: 'Planning' }],
  })

  for (const surface of SURFACES) {
    const working = await $.ui.mount({ ...band(true), surface })
    expect((await working.findAll({ type: 'Text' })).map(one => one.text)).toEqual(['engine band'])
    const idle = await $.ui.mount({ ...band(false), surface })
    expect((await idle.findAll({ type: 'Text' })).map(one => one.text)).toEqual(['engine band'])
  }
})

test('/task-demo fills the band and /task-demo clear empties it', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return h(Text, {}, 'engine band') as RenderElement
  })

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
  expect((await cleared.findAll({ type: 'Text' })).map(one => one.text)).toEqual(['engine band'])
})

test('the close button hides the band until the list changes', async ($, on) => {
  on('tool.call', { tool: 'TodoWrite' }, async (_$, e) => ({
    result: { oldTodos: [], newTodos: e.todos },
  }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return h(Text, {}, 'engine band') as RenderElement
  })
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
    expect(await lines(surface)).toEqual(['engine band'])

    // The same list written again stays closed; a changed one brings the band back
    await write(surface, 'pending')
    expect(await lines(surface)).toEqual(['engine band'])
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

test('draws what its own todo tool writes and refuses a malformed list', async $ => {
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
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return h(Text, {}, 'engine band') as RenderElement
  })
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
  expect(await lines()).toEqual(['engine band'])
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
