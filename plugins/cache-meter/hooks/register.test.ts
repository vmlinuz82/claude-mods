import type { On, RenderElement, TurnUsage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const MINUTE = 60_000
// The countdown ticks every second, so a test that moves the clock minutes ahead steps through each tick
const SLOW = { timeoutMs: 30_000 }
const MODEL = 'claude-opus-5-5'
const band = {
  plugin: 'cache-meter',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 200 } as never,
} as const

type Setup = { env: Record<string, string>; settings: Record<string, unknown>; rateLimits: unknown[] }
type Usage = { read: number; written: number; fresh?: number; model?: string }

// Stands in for the engine: the session's settings, environment and rate limits, and each model request answered
// with the next usage queued
const engine = (on: On, setup: Setup, queue: Usage[], beneath: 'none' | 'band' | 'stack' = 'none') => {
  on('session.start', async (_$, e) => e)
  on('session.usage', async () => ({
    value: { startedAt: 0, context: { window: 200_000 }, rateLimits: setup.rateLimits } as never,
  }))
  on('settings.read', async () => ({ value: setup.settings as never }))
  on('env.get', async (_$, e) => ({ value: setup.env[e.name] }))
  // What draws beneath the plugin: nothing (the engine's placeholder), another mod's band, or a stack of framed bands
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    if (beneath === 'none') {
      return { type: 'engine', ref: 0 } as RenderElement
    }

    const { Box, Text } = $.ui.resolve(e)
    if (beneath === 'band') {
      return h(Text, {}, 'other band') as RenderElement
    }

    return h(
      Box,
      { key: 'band-stack', flexDirection: 'column' },
      h(Box, { key: 'first', borderStyle: 'round', borderColor: 'promptBorder' }, h(Text, {}, 'first band')),
    ) as RenderElement
  })
  on('turn.step', async function* (_$, e) {
    const next = queue.shift()
    const usage: TurnUsage | null = next
      ? {
          input_tokens: next.fresh ?? 0,
          output_tokens: 100,
          cache_read_input_tokens: next.read,
          cache_creation_input_tokens: next.written,
          model: next.model ?? MODEL,
        }
      : null

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never
  })
}

const fresh = (): Setup => ({ env: {}, settings: {}, rateLimits: [] })

// A model request runs as its stream is read, so the helper reads it to the end
const step = async ($: Engine, queue: Usage[], usage: Usage, turnId: string, index = 0, extra: object = {}) => {
  queue.push(usage)
  const stream = $.turn.step({ turnId, index, model: usage.model ?? MODEL, messageCount: 1, ...extra } as never)
  for await (const _chunk of stream) {
    // nothing to show: only the result matters here
  }

  return stream.result
}

type Found = { text: string; props: { color?: string; alt?: string } }
type Mounted = { findAll: (query: { type: 'Text' | 'Svg' }) => Promise<Found[]> }

const texts = async (ui: Mounted) => (await ui.findAll({ type: 'Text' })).map(one => one.text)
const colorOf = async (ui: Mounted, text: string) =>
  (await ui.findAll({ type: 'Text' })).find(one => one.text === text)?.props.color
const lineStarting = async (ui: Mounted, start: string) => (await texts(ui)).find(one => one.startsWith(start)) ?? ''
const open = (ui: { press: (target: { key: string }) => Promise<unknown> }) => ui.press({ key: 'cache-meter-toggle' })
const STRIP = [
  'Cache warm',
  '5:00',
  'left',
  '11k',
  'tokens cached',
  '95%',
  'from cache',
  '5%',
  'of context used',
  '≈ 6.9k',
  'saved this session',
  'with 1 h TTL:',
  '−7.9k',
]

test(
  'shows the lifetime, the last request, the context and the cost of the turn and the session',
  SLOW,
  async ($, on) => {
    const clock = mock.clock(on, { now: 0 })
    const queue: Usage[] = []
    engine(on, fresh(), queue)
    await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

    await step($, queue, { read: 0, written: 10_000, fresh: 50 }, 't1', 0)
    await step($, queue, { read: 10_000, written: 500, fresh: 20 }, 't1', 1)
    // A subagent's request leaves the main conversation's meter alone
    await step($, queue, { read: 0, written: 90_000 }, 't1', 2, { agentId: 'agent-1' })

    // Opus 5.5 reads at 0.05, a 5-minute write costs 1.25 and output 5: the two requests cost 13,050 and 1,645
    // regular input tokens, against 10,550 and 11,020 with no cache
    const ui = await $.ui.mount({ ...band, surface: 'desktop' })
    // Closed, the band is one strip of pills; the arrow opens the details under it
    expect(await texts(ui)).toEqual(STRIP)
    await open(ui)
    expect(await texts(ui)).toEqual([
      ...STRIP,
      'Cache warm',
      '5:00',
      'left of 5 min TTL',
      '95%',
      'from cache',
      '10k',
      '500',
      '20',
      '5%',
      'context',
      '11k',
      'of 200k',
      // 10k came from the cache over the two requests; 10.5k written and 70 sent plain did not
      'Last turn · 2 requests · from cache 10k · not from cache 11k · output 200',
      'last request: read · written · new',
      // The bill: 14.7k regular input tokens against 21.6k without the cache, so 6.9k saved
      'Last turn saved ≈ 6.9k tokens (32%) · paid as for 15k regular input tokens instead of 22k',
      'Session · 1 turn · from cache 10k · not from cache 11k · output 200',
      'Session saved ≈ 6.9k tokens (32%) · paid as for 15k regular input tokens instead of 22k',
    ])
    // The desktop app draws the bars and dots as pictures, described for anyone who can't see them
    expect((await ui.findAll({ type: 'Svg' })).map(one => one.props.alt)).toEqual([
      'warm',
      'time left',
      'warm',
      '5:00 of 5 min left',
      'last request: 10k read, 500 written, 20 new',
      'read',
      'written',
      'new',
      '11k of 200k context',
    ])

    // Near the end the band says what an expiry would cost: the 10.5k cached tokens written again at 1.25
    await clock.advance(4.5 * MINUTE)
    expect(await colorOf(ui, '0:30')).toBe('warning')
    expect(
      await colorOf(
        ui,
        'If it expires: the next message costs as much as ≈ 13k regular input tokens — a short message now keeps it warm for ≈ 525',
      ),
    ).toBe('warning')
    expect(await colorOf(ui, 'if it expires')).toBe('warning')
    // and the tip beside it: the 10.5k cached read once at Opus 5.5's 0.05 is 525
    expect(await texts(ui)).toContain('· a short message now keeps it for ≈ 525')

    await clock.advance(2.5 * MINUTE)
    expect((await texts(ui)).slice(0, 2)).toEqual(['Cache expired', '2 min ago'])
    expect(await texts(ui)).toContain('next message')
    expect(await colorOf(ui, 'Next message re-sends 11k tokens: costs as much as ≈ 13k regular input tokens')).toBe(
      'warning',
    )

    // The arrow closes the details again
    await open(ui)
    expect(await texts(ui)).not.toContain('from cache · ')
    expect((await texts(ui)).some(one => one.startsWith('Session'))).toBe(false)
  },
)

test('the terminal spells the bars and dots in characters across the free width', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const queue: Usage[] = []
  engine(on, fresh(), queue)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await step($, queue, { read: 0, written: 10_000 }, 't1')
  await clock.advance(2.5 * MINUTE)

  const ui = await $.ui.mount({ ...band, surface: 'terminal' })
  expect((await texts(ui)).slice(0, 3)).toEqual(['●', 'Cache warm', '2:30'])
  await open(ui)
  // 200 columns less the label, value and gap columns leave 152 for the bar; half the lifetime is left
  const bars = (await texts(ui)).filter(one => /^[━─]+$/.test(one))
  expect(bars.slice(0, 2)).toEqual(['━'.repeat(76), '─'.repeat(76)])
  expect(await ui.findAll({ type: 'Svg' })).toEqual([])
})

test('learns a one-hour lifetime when the cache survives a longer pause', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const queue: Usage[] = []
  engine(on, fresh(), queue)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

  await step($, queue, { read: 0, written: 10_000 }, 't1')
  await clock.advance(20 * MINUTE)
  await step($, queue, { read: 10_000, written: 200 }, 't2')

  const ui = await $.ui.mount({ ...band, surface: 'desktop' })
  await open(ui)
  expect(await texts(ui)).toEqual(expect.arrayContaining(['1:00:00', 'left of 1 h TTL']))
})

test('names why a turn rebuilt the cache and counts rebuilds for the session', SLOW, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const queue: Usage[] = []
  engine(on, fresh(), queue)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...band, surface: 'desktop' })

  const cases = [
    { pause: 10 * MINUTE, model: MODEL, expected: 'expired after a 10 min pause' },
    { pause: MINUTE, model: 'claude-sonnet-5-5', expected: 'model switched to claude-sonnet-5-5' },
    {
      pause: MINUTE,
      model: 'claude-sonnet-5-5',
      expected: 'cause unknown — MCP tools, settings or a Claude Code update can reset it',
    },
  ]

  await step($, queue, { read: 0, written: 10_000 }, 'start')
  await open(ui)
  for (const [index, one] of cases.entries()) {
    await clock.advance(one.pause)
    await step($, queue, { read: 0, written: 12_000, model: one.model }, `t${index}`)
    expect(await colorOf(ui, `Last turn rebuilt the cache — ${one.expected}`)).toBe('warning')
  }

  expect(await lineStarting(ui, 'Session')).toEndWith(' · 3 rebuilds: expired, model switch, unknown')
})

test('takes the lifetime from settings, the environment or the kind of account', SLOW, async ($, on) => {
  mock.clock(on, { now: 0 })
  const queue: Usage[] = []
  const setup = fresh()
  engine(on, setup, queue)

  const cases = [
    { env: {}, settings: {}, rateLimits: [], ttl: '5 min' },
    { env: {}, settings: {}, rateLimits: [{ window: '5h' }], ttl: '1 h' },
    { env: {}, settings: { promptCacheTtl: '1h' }, rateLimits: [], ttl: '1 h' },
    { env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, settings: {}, rateLimits: [], ttl: '1 h' },
    {
      env: { FORCE_PROMPT_CACHING_5M: '1' },
      settings: { promptCacheTtl: '1h' },
      rateLimits: [{ window: '5h' }],
      ttl: '5 min',
    },
    { env: { ENABLE_PROMPT_CACHING_1H: '1' }, settings: {}, rateLimits: [], ttl: '1 h' },
  ]

  await step($, queue, { read: 0, written: 10_000 }, 't1')
  const ui = await $.ui.mount({ ...band, surface: 'desktop' })
  await open(ui)
  for (const one of cases) {
    Object.assign(setup, { env: one.env, settings: one.settings, rateLimits: one.rateLimits })
    await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
    expect(await lineStarting(ui, 'left of')).toBe(`left of ${one.ttl} TTL`)
  }
})

type HourCase = { setup: Setup; second: Usage; pill: string[] }

// One session: a request, a 20-minute pause, a second request; then the pill it leaves
const weigh = async ($: Engine, on: On, one: HourCase) => {
  const clock = mock.clock(on, { now: 0 })
  const queue: Usage[] = []
  engine(on, one.setup, queue)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await step($, queue, { read: 0, written: 10_000 }, 't1')
  await clock.advance(20 * MINUTE)
  await step($, queue, one.second, 't2')

  const ui = await $.ui.mount({ ...band, surface: 'desktop' })
  const strip = await texts(ui)
  expect(strip.slice(strip.indexOf(one.pill[0] ?? ''), strip.indexOf(one.pill[0] ?? '') + 2)).toEqual(one.pill)
}

test('weighs a one-hour cache that kept the conversation through a pause', SLOW, async ($, on) => {
  // 10k read at 0.05 instead of rewritten at 1.25 is 12k kept, against 10.2k written at 0.75 extra
  await weigh($, on, {
    setup: { env: {}, settings: { promptCacheTtl: '1h' }, rateLimits: [] },
    second: { read: 10_000, written: 200 },
    pill: ['1 h TTL so far:', '+4.3k'],
  })
})

test('weighs what a one-hour cache would have done for a five-minute cache that expired', SLOW, async ($, on) => {
  // The hour would have kept the 10k rewritten after the pause, 12k, against 20k written at 0.75 extra
  await weigh($, on, {
    setup: fresh(),
    second: { read: 0, written: 10_000 },
    pill: ['with 1 h TTL:', '−3.0k'],
  })
})

// The frames drawn like the prompt box: one per band in a stack
const frameCount = async (ui: Mounted) =>
  (
    await (
      ui as unknown as { findAll: (query: { type: string }) => Promise<{ props: { borderColor?: string } }[]> }
    ).findAll({ type: 'Box' })
  ).filter(one => one.props.borderColor === 'promptBorder').length

test('frames its band under the band of another mod', SLOW, async ($, on) => {
  const queue: Usage[] = []
  mock.clock(on, { now: 0 })
  engine(on, fresh(), queue, 'band')
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await step($, queue, { read: 0, written: 10_000 }, 't1')

  const ui = await $.ui.mount({ ...band, surface: 'desktop' })
  // The other band on top, then this one, each in a frame of its own
  expect((await texts(ui))[0]).toBe('other band')
  expect(await frameCount(ui)).toBe(2)
})

test('joins a stack another mod already framed instead of framing it again', SLOW, async ($, on) => {
  const queue: Usage[] = []
  mock.clock(on, { now: 0 })
  engine(on, fresh(), queue, 'stack')
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await step($, queue, { read: 0, written: 10_000 }, 't1')

  const ui = await $.ui.mount({ ...band, surface: 'desktop' })
  // The stack keeps its one frame and gains this band's: two in all, not a frame around the stack
  expect((await texts(ui))[0]).toBe('first band')
  expect(await frameCount(ui)).toBe(2)
})

test(
  'keeps the strip on one line, leaving out the least important pills when the band is narrow',
  SLOW,
  async ($, on) => {
    const queue: Usage[] = []
    mock.clock(on, { now: 0 })
    engine(on, fresh(), queue)
    await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
    await step($, queue, { read: 0, written: 10_000, fresh: 50 }, 't1', 0)
    await step($, queue, { read: 10_000, written: 500, fresh: 20 }, 't1', 1)

    // 50 columns leave 42 for pills: the state and the time fit, the saving (the next most important) does not
    const narrow = await $.ui.mount({
      ...band,
      props: { ...(band.props as object), bodyColumns: 50 } as never,
      surface: 'desktop',
    })
    expect(await texts(narrow)).toEqual(['Cache warm', '5:00', 'left'])
  },
)
