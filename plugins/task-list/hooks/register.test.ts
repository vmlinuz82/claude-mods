import type { RenderElement } from 'claude-code'
import { expect, test } from 'claude-code/testing'

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
