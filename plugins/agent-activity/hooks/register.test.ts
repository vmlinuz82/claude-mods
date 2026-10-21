import type { AgentInfo, AgentStatus, On, RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const SURFACES = ['desktop', 'terminal'] as const
const band = {
  plugin: 'agent-activity',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 100 } as never,
} as const
const START = 1_800_000_000_000

// Stands in for the engine: agents it starts and lists, tool calls it answers, its own band placeholder
const engine = (on: On, statuses: Map<string, AgentStatus>) => {
  let next = 0
  on('session.start', async (_$, e) => e)
  on('agent.spawn', async () => {
    const agentId = `agent-${++next}`
    statuses.set(agentId, 'running')

    return { model: 'claude-sonnet-5-5', agentId }
  })
  on('agent.list', async () => ({
    value: [...statuses].map(([id, status]): AgentInfo => ({ id, description: id, type: 'general-purpose', status })),
  }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('ui.render', { component: 'AbovePrompt' }, async () => ({ type: 'engine', ref: 0 }) as RenderElement)
}

const start = async ($: Engine, on: On) => {
  const statuses = new Map<string, AgentStatus>()
  const clock = mock.clock(on, { now: START })
  engine(on, statuses)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })

  return { statuses, clock }
}

const spawn = ($: Engine, description: string) =>
  $.agent.spawn({ prompt: 'do it', description } as never) as Promise<{ agentId?: string }>

const act = ($: Engine, agentId: string, input: Record<string, unknown>) => $.tool.call({ ...input, agentId } as never)

const lines = async ($: Engine, surface: (typeof SURFACES)[number]) =>
  (await (await $.ui.mount({ ...band, surface })).findAll({ type: 'Text' })).map(one => one.text)

test('a running agent shows its last action, how long it has run and how long ago it acted', async ($, on) => {
  const { clock } = await start($, on)
  const { agentId = '' } = await spawn($, 'Implement Plan 10 Task 8')
  await clock.advance(21 * 60_000)
  await act($, agentId, { tool: 'Edit', file_path: '/home/k/poevtini/apps/client/src/routes/profile/PlanCard.tsx' })
  await clock.advance(15_000)

  for (const surface of SURFACES) {
    expect((await lines($, surface)).join(' ')).toContain(
      'Implement Plan 10 Task 8 · running 21 min · Edit …/profile/PlanCard.tsx · 15 s ago',
    )
  }
})

test('an agent active in the last 30 seconds spins: an animated image on the desktop, a text spinner in the terminal', async ($, on) => {
  const { clock } = await start($, on)
  const { agentId = '' } = await spawn($, 'Review Plan 10 Task 7')
  await act($, agentId, { tool: 'Bash', command: 'npx vitest run apps/client --reporter dot' })

  const desktop = await $.ui.mount({ ...band, surface: 'desktop' })
  expect(await desktop.findAll({ type: 'Svg' })).toHaveLength(1)
  expect((await lines($, 'terminal'))[0]).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Review Plan 10 Task 7 · running 0 min · Bash: npx vitest run apps\/client/)
  // The terminal spinner steps
  const before = (await lines($, 'terminal'))[0]?.[0]
  await clock.advance(250)
  expect((await lines($, 'terminal'))[0]?.[0]).not.toBe(before)

  // Quiet for a while: a still marker
  await clock.advance(60_000)
  expect(await (await $.ui.mount({ ...band, surface: 'desktop' })).findAll({ type: 'Svg' })).toHaveLength(0)
  expect((await lines($, 'terminal'))[0]).toMatch(/^◼ Review Plan 10 Task 7 · running 1 min · Bash: .* · 1 min ago$/)
})

test('an agent with no activity for 5 minutes shows amber, and a finished agent leaves the band', async ($, on) => {
  const { statuses, clock } = await start($, on)
  const first = (await spawn($, 'Implement Plan 10 Task 9')).agentId ?? ''
  const second = (await spawn($, 'Implement Plan 10 Task 10')).agentId ?? ''
  await act($, first, { tool: 'Read', file_path: '/repo/src/A.php' })
  await clock.advance(7 * 60_000)
  await act($, second, { tool: 'Grep', pattern: 'trial_ends_at' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...band, surface })
    const texts = await ui.findAll({ type: 'Text' })
    const stuck = texts.find(one => one.text.includes('Task 9'))
    expect(stuck?.text).toContain('Implement Plan 10 Task 9 · running 7 min · no activity for 7 min')
    expect(stuck?.props.color).toBe('warning')
  }

  // The engine reports Task 9 finished: gone at the next look
  statuses.set(first, 'completed')
  await clock.advance(15_000)
  for (const surface of SURFACES) {
    const all = (await lines($, surface)).join('\n')
    expect(all).not.toContain('Task 9')
    expect(all).toContain('Task 10')
  }

  // No agent running: no band
  statuses.set(second, 'failed')
  await clock.advance(15_000)
  expect(await lines($, 'desktop')).toEqual([])
})

test('the close button hides the band until a new agent starts', async ($, on) => {
  await start($, on)
  const { agentId = '' } = await spawn($, 'Implement Plan 10 Task 8')
  await act($, agentId, { tool: 'Bash', command: 'ls' })

  const ui = await $.ui.mount({ ...band, surface: 'desktop' })
  expect((await ui.find({ key: 'close' }))?.props.role).toBe('dismiss')
  await ui.press({ key: 'close' })
  expect(await lines($, 'desktop')).toEqual([])

  // More actions by the same agent keep it closed; a new agent brings it back
  await act($, agentId, { tool: 'Bash', command: 'pwd' })
  expect(await lines($, 'desktop')).toEqual([])
  await spawn($, 'Review Plan 10 Task 8')
  expect((await lines($, 'desktop')).join(' ')).toContain('Review Plan 10 Task 8')
})

test('tool calls on the main loop are not agents', async ($, on) => {
  await start($, on)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)

  expect(await lines($, 'desktop')).toEqual([])
})

// Another mod's band beneath this one: kept, each band in its own frame
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

test('the band keeps another mod band, each framed like the prompt box', { plugins: [OTHER_BAND] }, async ($, on) => {
  await start($, on)
  await spawn($, 'Implement Plan 10 Task 8')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...band, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
    expect(texts[0]).toBe('other band')
    expect(texts.join(' ')).toContain('Implement Plan 10 Task 8')
    const frames = (await ui.findAll({ type: 'Box' })).filter(box => box.props.borderStyle === 'round')
    expect(frames).toHaveLength(2)
  }
})


// Two other mods' bands beneath, already stacked and framed by one of them (key band-stack)
const STACKED_BANDS = {
  name: 'stacked-bands',
  tier: 'append',
  register: (on: On) => {
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Box, Text } = $.ui.resolve(e)
      const frame = (key: string, text: string) =>
        h(Box, { key, flexDirection: 'column', borderStyle: 'round', borderColor: 'promptBorder', paddingX: 1 }, h(Text, {}, text))

      return h(Box, { key: 'band-stack', flexDirection: 'column', rowGap: 1 }, frame('a', 'task band'), frame('b', 'skills band')) as RenderElement
    })
  },
} as const

test('a stack of bands other mods already framed is joined, not framed again', { plugins: [STACKED_BANDS] }, async ($, on) => {
  await start($, on)
  await spawn($, 'Implement Plan 10 Task 8')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...band, surface })
    const frames = (await ui.findAll({ type: 'Box' })).filter(box => box.props.borderStyle === 'round')
    // Three frames side by side in one stack: no frame inside a frame
    expect(frames).toHaveLength(3)
    expect((await ui.findAll({ type: 'Text' })).map(one => one.text).slice(0, 2)).toEqual(['task band', 'skills band'])
  }
})

test('an agent only listed by the engine shows once it acts, and a waiting or idle agent is not running', async ($, on) => {
  const { statuses, clock } = await start($, on)
  // Agents from before this mod loaded: one finished but resumable, one idle, one really running
  statuses.set('old-done', 'waiting')
  statuses.set('old-idle', 'idle')
  statuses.set('old-busy', 'running')
  await clock.advance(15_000)
  expect(await lines($, 'desktop')).toEqual([])

  // The running one acts: it appears, with its action
  await act($, 'old-busy', { tool: 'Bash', command: 'npx vitest run' })
  const shown = (await lines($, 'terminal')).join('\n')
  expect(shown).toContain('Bash: npx vitest run')
  expect(shown).not.toContain('old-done')
  expect(shown).not.toContain('old-idle')

  // A spawned agent that goes waiting (done, resumable) leaves the band
  const { agentId = '' } = await spawn($, 'Implement Plan 10 Task 10')
  statuses.set(agentId, 'waiting')
  await clock.advance(15_000)
  expect((await lines($, 'desktop')).join('\n')).not.toContain('Task 10')
})
