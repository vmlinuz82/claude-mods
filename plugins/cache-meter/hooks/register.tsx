import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, TurnUsage } from 'claude-code'

import type { CacheRequest, HourVsFive, Lifetime, SessionTally, Tally, TurnSummary } from '../types'

const SECOND = 1000
const MINUTE = 60 * SECOND
const FIVE_MINUTES = 5 * MINUTE
const ONE_HOUR = 60 * MINUTE
// Claude's prompt cache lifetimes today, shortest first; a longer one is learned when the cache outlives them
const KNOWN_LIFETIMES = [FIVE_MINUTES, ONE_HOUR]
const TTL_SETTING_VALUES: Readonly<Record<string, number>> = { '5m': FIVE_MINUTES, '1h': ONE_HOUR }
// The countdown shows seconds, so the clock is read every second
const TICK_MS = SECOND
// The countdown turns amber in the last 15% of the lifetime
const WARN_SHARE = 0.15
// The context bar turns amber from 70% full and red from 90%, where automatic compaction gets close
const CONTEXT_WARN = 0.7
const CONTEXT_FULL = 0.9
// A turn's first request that wrote more than it read rebuilt the cache instead of reading it
const REBUILT_SHARE = 0.5
const KEEP_TURNS = 50
// Output costs five times the input price on every current Claude model
const OUTPUT_RATE = 5
// Fixed-width columns either side, so the bars start and end at the same place
const LABEL_COLUMNS = 18
const VALUE_COLUMNS = 26
const BAR_HEIGHT = 6
const DOT_SIZE = 8
// A drawing can't follow the theme, so its colours match the theme's success, warning, error and text colours
const PAINT = { track: '#3d3d3d', success: '#2ea35e', warning: '#e0a526', error: '#d9534f', text: '#e8e8e8' } as const
// Pill fills are theme keys, so they follow a light or dark theme: a tint of green or red, otherwise the grey the
// theme fills a user message with. No theme key holds an amber fill, so the amber pill is grey with amber text
const TINT: Readonly<Record<Tone, string>> = {
  success: 'diffAddedDimmed',
  warning: 'userMessageBackground',
  error: 'diffRemovedDimmed',
  text: 'userMessageBackground',
}
// How the terminal, which can't draw, spells the same bars and dots
const FILLED = '━'
const EMPTY = '─'
const DOT = '●'

type Tone = 'success' | 'warning' | 'error' | 'text'
type Segment = { share: number; tone: Tone }
type Change = { text: string; kind: string }

const EMPTY_TALLY: Tally = { requests: 0, read: 0, written: 0, fresh: 0, output: 0, cost: 0, costWithoutCache: 0 }
const EMPTY_HOUR: HourVsFive = { pauses: 0, kept: 0, extra: 0 }

// State saved by an earlier version of the mod lacks the newer fields: its turns are left out, and the session's
// missing totals start at zero, so a reload never shows NaN or undefined
const isCurrentTurn = (one: TurnSummary): boolean =>
  typeof one.requests === 'number' && typeof one.cost === 'number' && typeof one.output === 'number'

const sessionOf = (stored: Partial<SessionTally>): SessionTally => ({
  ...EMPTY_TALLY,
  ...stored,
  turns: stored.turns ?? 0,
  rebuilds: stored.rebuilds ?? {},
  hour: { ...EMPTY_HOUR, ...stored.hour },
})

const last = atom({ plugin: 'cache-meter', key: 'last' } as const, null)
const lifetime = atom({ plugin: 'cache-meter', key: 'lifetime' } as const, { ms: FIVE_MINUTES, source: 'default' })
const turns = atom({ plugin: 'cache-meter', key: 'turns' } as const, [])
const session = atom({ plugin: 'cache-meter', key: 'session' } as const, {
  ...EMPTY_TALLY,
  turns: 0,
  rebuilds: {},
  hour: EMPTY_HOUR,
})
const contextWindow = atom({ plugin: 'cache-meter', key: 'window' } as const, null)
const clock = atom({ plugin: 'cache-meter', key: 'clock' } as const, 0)
const isExpanded = atom({ plugin: 'cache-meter', key: 'isExpanded' } as const, false)

const duration = (ms: number): string => {
  if (ms < MINUTE) {
    return `${Math.max(1, Math.round(ms / SECOND))} s`
  }

  if (ms < ONE_HOUR) {
    return `${Math.round(ms / MINUTE)} min`
  }

  const hours = Math.floor(ms / ONE_HOUR)
  const minutes = Math.round((ms % ONE_HOUR) / MINUTE)

  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`
}

const tokens = (count: number): string => {
  const rounded = Math.round(count)
  if (rounded < 1000) {
    return String(rounded)
  }

  if (rounded < 10_000) {
    return `${(rounded / 1000).toFixed(1)}k`
  }

  if (rounded < 1_000_000) {
    return `${Math.round(rounded / 1000)}k`
  }

  return `${(rounded / 1_000_000).toFixed(1)}M`
}

const percent = (part: number, whole: number): string => `${Math.round(share(part, whole) * 100)}%`

const share = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole)

// Cache reads cost a tenth of the input price, less on the newest models (Anthropic's prompt caching prices)
const readRate = (model: string): number => {
  if (/fable-5-1|mythos-5-1/.test(model)) {
    return 0.025
  }

  return /-5-5/.test(model) ? 0.05 : 0.1
}

// Writing to the cache costs 1.25 times the input price for five minutes, twice for an hour
const writeRate = (lifetimeMs: number): number => (lifetimeMs >= ONE_HOUR ? 2 : 1.25)

const tallyOf = (request: CacheRequest, lifetimeMs: number): Tally => ({
  requests: 1,
  read: request.read,
  written: request.written,
  fresh: request.fresh,
  output: request.output,
  cost:
    request.fresh +
    request.read * readRate(request.model) +
    request.written * writeRate(lifetimeMs) +
    request.output * OUTPUT_RATE,
  costWithoutCache: request.fresh + request.read + request.written + request.output * OUTPUT_RATE,
})

const add = <T extends Tally>(into: T, more: Tally): T => ({
  ...into,
  requests: into.requests + more.requests,
  read: into.read + more.read,
  written: into.written + more.written,
  fresh: into.fresh + more.fresh,
  output: into.output + more.output,
  cost: into.cost + more.cost,
  costWithoutCache: into.costWithoutCache + more.costWithoutCache,
})

const saved = (tally: Tally): string => percent(tally.costWithoutCache - tally.cost, tally.costWithoutCache)

// How many tokens came from the cache and how many did not (written to it, or sent as plain input), and the output
const usageLine = (label: string, tally: Tally): string =>
  `${label} · from cache ${tokens(tally.read)} · not from cache ${tokens(tally.written + tally.fresh)} · output ${tokens(tally.output)}`

// What the cache saved, counted in regular input tokens: the bill without the cache less the bill with it
const savedTokens = (tally: Tally): number => tally.costWithoutCache - tally.cost

// The saving first, then the two bills it comes from, each as many regular input tokens as it would buy
const savingLine = (label: string, tally: Tally): string =>
  `${label} saved ≈ ${tokens(savedTokens(tally))} tokens (${saved(tally)}) · paid as for ${tokens(tally.cost)} regular input tokens instead of ${tokens(tally.costWithoutCache)}`

const isRebuilt = (request: CacheRequest): boolean => request.written > REBUILT_SHARE * (request.read + request.written)

// Claude Code's own order: FORCE_PROMPT_CACHING_5M, the variable, the setting, ENABLE_PROMPT_CACHING_1H
const configuredLifetime = async ($: EngineInterface): Promise<number | null> => {
  if ((await $.env.get('FORCE_PROMPT_CACHING_5M')) === '1') {
    return FIVE_MINUTES
  }

  const fromEnv = TTL_SETTING_VALUES[(await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')) ?? '']
  if (fromEnv !== undefined) {
    return fromEnv
  }

  const { promptCacheTtl } = (await $.settings.read()) as { promptCacheTtl?: unknown }
  const fromSettings = typeof promptCacheTtl === 'string' ? TTL_SETTING_VALUES[promptCacheTtl] : undefined
  if (fromSettings !== undefined) {
    return fromSettings
  }

  return (await $.env.get('ENABLE_PROMPT_CACHING_1H')) === '1' ? ONE_HOUR : null
}

const resolveLifetime = async ($: EngineInterface): Promise<Lifetime> => {
  const configured = await configuredLifetime($)
  if (configured !== null) {
    return { ms: configured, source: 'setting' }
  }

  // A Claude subscription has rate-limit windows and caches the main conversation for an hour; an API key, five minutes
  const { rateLimits } = await $.session.usage()

  return { ms: rateLimits.length > 0 ? ONE_HOUR : FIVE_MINUTES, source: 'default' }
}

const readWindow = async ($: EngineInterface): Promise<void> => {
  const { context } = await $.session.usage()
  await update($, contextWindow, () => context.window)
}

// What a pause taught about the lifetime: a hit after a longer pause than assumed means the cache lasts at least
// that long; a rebuild after a pause the assumed lifetime should have covered, with nothing else to explain it,
// means it is shorter
const learn = (now: Lifetime, gap: number, rebuilt: boolean, otherCause: Change | null): Lifetime => {
  if (!rebuilt && gap > now.ms) {
    return { ms: KNOWN_LIFETIMES.find(one => one >= gap) ?? Math.ceil(gap / MINUTE) * MINUTE, source: 'observed' }
  }

  if (rebuilt && otherCause === null && gap > FIVE_MINUTES && gap <= now.ms) {
    return { ms: [...KNOWN_LIFETIMES].reverse().find(one => one < gap) ?? FIVE_MINUTES, source: 'observed' }
  }

  return now
}

const changeBetween = (before: CacheRequest, after: CacheRequest, wasCompacted: boolean): Change | null => {
  if (after.model !== before.model) {
    return { text: `model switched to ${after.model}`, kind: 'model switch' }
  }

  if (after.effort !== before.effort) {
    return { text: 'effort changed', kind: 'effort change' }
  }

  return wasCompacted ? { text: '/compact', kind: '/compact' } : null
}

// Why the turn's first request rebuilt the cache, or null when it read it
const rebuildOf = (
  before: CacheRequest | null,
  request: CacheRequest,
  gap: number,
  ms: number,
  change: Change | null,
) => {
  if (before === null || !isRebuilt(request)) {
    return null
  }

  if (gap > ms) {
    return { text: `expired after a ${duration(gap)} pause`, kind: 'expired' }
  }

  return change ?? { text: 'cause unknown — MCP tools, settings or a Claude Code update can reset it', kind: 'unknown' }
}

const tick = async ($: EngineInterface): Promise<void> => {
  const now = await $.clock.now()
  await update($, clock, () => now)
}

// m:ss, or h:mm:ss from an hour up
const clockFace = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / SECOND))
  const seconds = String(total % 60).padStart(2, '0')
  const minutes = Math.floor(total / 60)
  if (minutes < 60) {
    return `${minutes}:${seconds}`
  }

  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`
}

// A bar as an SVG picture: a track, then each segment in turn; a tiny share still shows as a notch
const barPicture = (segments: readonly Segment[]): string => {
  let x = 0
  const rects = segments
    .filter(segment => segment.share > 0)
    .map(segment => {
      const width = Math.max(8, Math.round(segment.share * 1000))
      const rect = `<rect x="${x}" width="${width}" height="${BAR_HEIGHT}" fill="${PAINT[segment.tone]}"/>`
      x += width

      return rect
    })

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${BAR_HEIGHT}" viewBox="0 0 1000 ${BAR_HEIGHT}" preserveAspectRatio="none">` +
    `<clipPath id="r"><rect width="1000" height="${BAR_HEIGHT}" rx="${BAR_HEIGHT / 2}"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="1000" height="${BAR_HEIGHT}" fill="${PAINT.track}"/>${rects.join('')}</g></svg>`
  )
}

const clockPicture = (tone: Tone): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="${PAINT[tone]}" stroke-width="1.4" stroke-linecap="round">` +
  `<circle cx="6" cy="6" r="5"/><path d="M6 3.2V6l2 1.3"/></svg>`

const dotPicture = (tone: Tone): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${DOT_SIZE}" height="${DOT_SIZE}" viewBox="0 0 ${DOT_SIZE} ${DOT_SIZE}">` +
  `<circle cx="${DOT_SIZE / 2}" cy="${DOT_SIZE / 2}" r="${DOT_SIZE / 2}" fill="${PAINT[tone]}"/></svg>`

// The same bar in terminal cells: each segment's share of the width, at least one cell when it has any
const barCells = (segments: readonly Segment[], width: number): { cells: number; tone: Tone }[] =>
  segments
    .filter(segment => segment.share > 0)
    .map(segment => ({ cells: Math.max(1, Math.round(segment.share * width)), tone: segment.tone }))

const rebuildList = (rebuilds: Readonly<Record<string, number>>): string => {
  const kinds = Object.entries(rebuilds)
  const count = kinds.reduce((sum, [, times]) => sum + times, 0)
  if (count === 0) {
    return ''
  }

  const names = kinds.map(([kind, times]) => (times > 1 ? `${kind} ×${times}` : kind)).join(', ')

  return ` · ${count} rebuild${count > 1 ? 's' : ''}: ${names}`
}

// What the hour's dearer writes add on top of five-minute ones: paid with a one-hour cache, avoided with a
// five-minute one
const hourExtra = (request: CacheRequest): number => request.written * (writeRate(ONE_HOUR) - writeRate(FIVE_MINUTES))

// A turn after a pause between five minutes and an hour is where the two lifetimes part: the hour reads the
// conversation from cache where five minutes writes it again. With a one-hour cache that kept it, the read part was
// kept; with a five-minute cache that expired, the rewritten part is what the hour would have kept
const hourKept = (request: CacheRequest, gap: number, ms: number, rebuildKind: string | null): number => {
  if (gap <= FIVE_MINUTES || gap > ONE_HOUR) {
    return 0
  }

  const saving = writeRate(FIVE_MINUTES) - readRate(request.model)
  if (ms >= ONE_HOUR) {
    return isRebuilt(request) ? 0 : request.read * saving
  }

  return rebuildKind === 'expired' ? request.written * saving : 0
}

// Each pill takes its words, a space between them, and a border and a space either side; one cell between pills
const PILL_FRAME = 4
// Cells the strip keeps for the arrow and the band's own frame
const STRIP_RESERVED = 8

// The pills that fit the strip on one line: the best ranked first until the room runs out, shown in their own order
const fitPills = (
  pills: readonly { rank: number; words: string[]; node: JSX.Element }[],
  room: number,
): JSX.Element[] => {
  const width = (pill: { words: string[] }) => pill.words.join(' ').length + PILL_FRAME + 1
  const kept = new Set<number>()
  let used = 0
  for (const pill of [...pills].sort((a, b) => a.rank - b.rank)) {
    if (used + width(pill) <= room) {
      used += width(pill)
      kept.add(pill.rank)
    }
  }

  return pills.filter(pill => kept.has(pill.rank)).map(pill => pill.node)
}

const record = async (
  $: EngineInterface,
  turnId: string,
  index: number,
  request: CacheRequest,
  wasCompacted: boolean,
): Promise<void> => {
  const before = await read($, last)
  const known = await read($, lifetime)
  const tally = tallyOf(request, known.ms)
  await update($, clock, now => Math.max(now, request.at))
  await update($, last, () => request)
  await update($, session, (stored: SessionTally) => {
    const now = sessionOf(stored)

    return { ...add(now, tally), hour: { ...now.hour, extra: now.hour.extra + hourExtra(request) } }
  })

  if (index > 0) {
    await update($, turns, list =>
      list.filter(isCurrentTurn).map(one => (one.turnId === turnId ? add(one, tally) : one)),
    )

    return
  }

  const gap = before === null ? 0 : request.at - before.at
  const change = before === null ? null : changeBetween(before, request, wasCompacted)
  const learned = before === null ? known : learn(known, gap, isRebuilt(request), change)
  if (learned !== known) {
    await update($, lifetime, () => learned)
  }

  const rebuild = rebuildOf(before, request, gap, learned.ms, change)
  const summary: TurnSummary = {
    ...tally,
    turnId,
    at: request.at,
    rebuiltBecause: rebuild?.text ?? null,
    rebuildKind: rebuild?.kind ?? null,
  }
  await update($, turns, list =>
    [summary, ...list.filter(one => isCurrentTurn(one) && one.turnId !== turnId)].slice(0, KEEP_TURNS),
  )
  const kept = before === null ? 0 : hourKept(request, gap, learned.ms, rebuild?.kind ?? null)
  await update($, session, (stored: SessionTally) => {
    const now = sessionOf(stored)

    return {
      ...now,
      turns: now.turns + 1,
      rebuilds:
        rebuild === null ? now.rebuilds : { ...now.rebuilds, [rebuild.kind]: (now.rebuilds[rebuild.kind] ?? 0) + 1 },
      hour: kept > 0 ? { ...now.hour, pauses: now.hour.pauses + 1, kept: now.hour.kept + kept } : now.hour,
    }
  })
  await readWindow($)
}

export const register: Register = on => {
  // Compaction rewrites the conversation, so the next request rebuilds the cache; noted until that request
  let wasCompacted = false

  on('session.start', async ($, e, next) => {
    const resolved = await resolveLifetime($)
    await update($, lifetime, now => (now.source === 'observed' ? now : resolved))
    await readWindow($)
    await tick($)
    $.clock.every(TICK_MS, () => void tick($))

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    wasCompacted = true

    return result
  })

  on('turn.step', async function* ($, e, next) {
    const at = await $.clock.now()
    const response = yield* next(e)
    const usage: TurnUsage | null = response.usage

    // Subagents keep caches of their own; the meter follows the main conversation
    if (e.agentId !== undefined || usage === null) {
      return response
    }

    const request: CacheRequest = {
      at,
      read: usage.cache_read_input_tokens,
      written: usage.cache_creation_input_tokens,
      fresh: usage.input_tokens,
      output: usage.output_tokens,
      model: usage.model,
      effort: e.effort === undefined ? null : String(e.effort),
    }

    // Below the minimum cacheable length nothing is cached, and there is nothing to count down
    if (request.read + request.written > 0) {
      await record($, e.turnId, e.index, request, wasCompacted)
      if (e.index === 0) {
        wasCompacted = false
      }
    }

    return response
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const request = await read($, last)
    if (e.props.hasSurvey || request === null) {
      return next(e)
    }

    const { ms } = await read($, lifetime)
    const now = Math.max(await read($, clock), request.at)
    const left = request.at + ms - now
    const cached = request.read + request.written
    const sent = cached + request.fresh
    const [turn] = (await read($, turns)).filter(isCurrentTurn)
    const totals = sessionOf(await read($, session))
    const window = await read($, contextWindow)
    const isExpired = left <= 0
    const isEnding = !isExpired && left <= ms * WARN_SHARE
    const tone: Tone = isExpired ? 'error' : isEnding ? 'warning' : 'success'
    const fill = window ? sent / window : 0
    const fillTone: Tone = fill >= CONTEXT_FULL ? 'error' : fill >= CONTEXT_WARN ? 'warning' : 'success'
    // An expired cache is written again whole, at the write price
    const expiryCost = tokens(cached * writeRate(ms))
    // A short message before it expires reads the conversation once from cache and restarts the clock; the short
    // reply it gets is left out, small beside the read
    const keepAliveCost = tokens(cached * readRate(request.model))
    const keepAliveTip = `a short message now keeps it for ≈ ${keepAliveCost}`

    const expanded = await read($, isExpanded)

    const table = $.ui.resolve(e)
    const { Box, Button, Text } = table
    // The desktop app draws pictures; the terminal spells the same bars and dots in characters
    // (decided by the surface: the terminal's element table lists Svg too, but cannot draw it)
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : null
    const barColumns = Math.max(10, e.props.bodyColumns - LABEL_COLUMNS - VALUE_COLUMNS - 4)

    const bar = (key: string, segments: readonly Segment[], alt: string) => {
      if (Svg) {
        return (
          <Box key={key} flexGrow={1}>
            <Svg source={barPicture(segments)} alt={alt} height={BAR_HEIGHT} />
          </Box>
        )
      }

      const cells = barCells(segments, barColumns)
      const used = cells.reduce((sum, part) => sum + part.cells, 0)

      return (
        <Box key={key} flexGrow={1} flexDirection="row">
          {cells.map((part, index) => (
            <Text key={`${key}-${index}`} color={part.tone}>
              {FILLED.repeat(part.cells)}
            </Text>
          ))}
          <Text key={`${key}-rest`} color="subtle">
            {EMPTY.repeat(Math.max(0, barColumns - used))}
          </Text>
        </Box>
      )
    }

    const dot = (key: string, dotTone: Tone, alt: string) =>
      Svg ? (
        <Svg key={key} source={dotPicture(dotTone)} alt={alt} width={DOT_SIZE} height={DOT_SIZE} />
      ) : (
        <Text key={key} color={dotTone}>
          {DOT}
        </Text>
      )

    // One row: a label column, a bar, and a value column, so every bar lines up
    const row = (key: string, label: JSX.Element[], barElement: JSX.Element, value: JSX.Element[]) => (
      <Box key={key} flexDirection="row" alignItems="center" columnGap={2}>
        <Box key={`${key}-label`} width={LABEL_COLUMNS} flexDirection="row" alignItems="center" columnGap={1}>
          {label}
        </Box>
        {barElement}
        <Box key={`${key}-value`} width={VALUE_COLUMNS} flexDirection="row" justifyContent="flex-end" columnGap={1}>
          {value}
        </Box>
      </Box>
    )

    const legend = [
      { key: 'read', count: request.read, legendTone: 'success' as const },
      { key: 'written', count: request.written, legendTone: 'warning' as const },
      { key: 'new', count: request.fresh, legendTone: 'text' as const },
    ]

    const alert = isExpired
      ? `Next message re-sends ${tokens(cached)} tokens: costs as much as ≈ ${expiryCost} regular input tokens`
      : isEnding
        ? `If it expires: the next message costs as much as ≈ ${expiryCost} regular input tokens — a short message now keeps it warm for ≈ ${keepAliveCost}`
        : turn?.rebuiltBecause
          ? `Last turn rebuilt the cache — ${turn.rebuiltBecause}`
          : null

    // One rounded pill of the strip, filled with no visible outline: grey, or a tint of its tone when it warns. The
    // border, in the fill's colour, is what rounds the corners
    const pill = (key: string, pillTone: Tone | null, content: JSX.Element[]) => (
      <Box
        key={key}
        borderStyle="round"
        borderColor={TINT[pillTone ?? 'text']}
        backgroundColor={TINT[pillTone ?? 'text']}
        paddingX={1}
        paddingY={0}
        flexDirection="row"
        alignItems="center"
        columnGap={1}
      >
        {content}
      </Box>
    )

    const strongTone = (value: Tone) => (value === 'success' ? undefined : value)
    // What the cache saved this session, the headline of the strip
    const sessionSaved = totals.requests > 0 ? `≈ ${tokens(savedTokens(totals))}` : null
    // The one-hour cache against five minutes this session: what it kept, less what its dearer writes cost
    const hourNet = totals.hour.kept - totals.hour.extra

    // The pills of the one-line strip, in the order they show; rank says which stay when the band is too narrow for
    // all of them (1 stays longest). words are their texts, to estimate the width each takes in cells
    const candidates: { rank: number; words: string[]; node: JSX.Element }[] = [
      {
        rank: 1,
        words: [isExpired ? 'Cache expired' : 'Cache warm', '●'],
        node: pill('pill-state', tone, [
          dot('pill-state-dot', tone, isExpired ? 'expired' : 'warm'),
          <Text key="pill-state-text" color={tone}>
            {isExpired ? 'Cache expired' : 'Cache warm'}
          </Text>,
        ]),
      },
      {
        rank: 2,
        words: [isExpired ? `${duration(-left)} ago` : `${clockFace(left)} left`, '◷'],
        node: pill('pill-time', null, [
          ...(Svg
            ? [<Svg key="pill-time-icon" source={clockPicture(tone)} alt="time left" width={12} height={12} />]
            : []),
          <Text key="pill-time-text" bold color={strongTone(tone)}>
            {isExpired ? `${duration(-left)} ago` : clockFace(left)}
          </Text>,
          ...(isExpired
            ? []
            : [
                <Text key="pill-time-note" dimColor>
                  left
                </Text>,
              ]),
        ]),
      },
      {
        rank: 8,
        words: [tokens(cached), 'tokens cached'],
        node: pill('pill-cached', null, [
          <Text key="pill-cached-count" bold>
            {tokens(cached)}
          </Text>,
          <Text key="pill-cached-text" dimColor>
            tokens cached
          </Text>,
        ]),
      },
      {
        rank: 7,
        words: [percent(request.read, sent), 'from cache'],
        node: pill('pill-hit', null, [
          <Text key="pill-hit-share" bold color="success">
            {percent(request.read, sent)}
          </Text>,
          <Text key="pill-hit-text" dimColor>
            from cache
          </Text>,
        ]),
      },
      ...(window !== null
        ? [
            {
              rank: 6,
              words: [percent(sent, window), 'of context used'],
              node: pill('pill-context', fillTone === 'success' ? null : fillTone, [
                <Text key="pill-context-share" bold color={strongTone(fillTone)}>
                  {percent(sent, window)}
                </Text>,
                <Text key="pill-context-text" dimColor>
                  of context used
                </Text>,
              ]),
            },
          ]
        : []),
      ...(sessionSaved
        ? [
            {
              rank: 5,
              words: [sessionSaved, 'saved this session'],
              node: pill('pill-saved', null, [
                <Text key="pill-saved-count" bold color="success">
                  {sessionSaved}
                </Text>,
                <Text key="pill-saved-text" dimColor>
                  saved this session
                </Text>,
              ]),
            },
          ]
        : []),
      ...(totals.hour.kept > 0 || totals.hour.extra > 0
        ? [
            {
              rank: 3,
              words: [ms >= ONE_HOUR ? '1 h TTL so far:' : 'with 1 h TTL:', '+0000k'],
              node: pill('pill-hour', null, [
                <Text key="pill-hour-text" dimColor>
                  {ms >= ONE_HOUR ? '1 h TTL so far:' : 'with 1 h TTL:'}
                </Text>,
                <Text key="pill-hour-net" bold color={hourNet >= 0 ? 'success' : 'warning'}>
                  {`${hourNet >= 0 ? '+' : '−'}${tokens(Math.abs(hourNet))}`}
                </Text>,
              ]),
            },
          ]
        : []),
      ...(isExpired || isEnding
        ? [
            {
              rank: 4,
              words: [`≈ ${expiryCost}`, isExpired ? 'next message' : `if it expires · ${keepAliveTip}`],
              node: pill('pill-expiry', 'warning', [
                <Text key="pill-expiry-cost" bold color="warning">
                  {`≈ ${expiryCost}`}
                </Text>,
                <Text key="pill-expiry-text" color="warning">
                  {isExpired ? 'next message' : 'if it expires'}
                </Text>,
                ...(isExpired
                  ? []
                  : [
                      <Text key="pill-expiry-tip" dimColor>
                        {`· ${keepAliveTip}`}
                      </Text>,
                    ]),
              ]),
            },
          ]
        : []),
    ]
    const shown = fitPills(candidates, e.props.bodyColumns - STRIP_RESERVED)

    // The one-line strip: the numbers that matter at a glance, and the arrow that opens everything else
    const strip = (
      <Box key="strip" flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={2}>
        <Box key="pills" flexDirection="row" flexWrap="nowrap" columnGap={1}>
          {shown}
        </Box>
        <Button
          key="cache-meter-toggle"
          label={expanded ? '↓' : '↑'}
          plain
          dimColor
          onPress={() => update($, isExpanded, now => !now)}
        />
      </Box>
    )

    const details = (
      <Box key="details" flexDirection="column">
        {row(
          'ttl',
          [
            dot('state-dot', tone, isExpired ? 'expired' : 'warm'),
            <Text key="state" bold>
              {isExpired ? 'Cache expired' : 'Cache warm'}
            </Text>,
          ],
          bar('ttl-bar', [{ share: Math.max(0, left) / ms, tone }], `${clockFace(left)} of ${duration(ms)} left`),
          [
            <Text key="time" bold color={tone === 'success' ? undefined : tone}>
              {isExpired ? duration(-left) : clockFace(left)}
            </Text>,
            <Text key="time-note" dimColor>
              {isExpired ? 'ago' : `left of ${duration(ms)} TTL`}
            </Text>,
          ],
        )}
        {row(
          'mix',
          [
            <Text key="share" bold>
              {percent(request.read, sent)}
            </Text>,
            <Text key="share-note" dimColor>
              from cache
            </Text>,
          ],
          bar(
            'mix-bar',
            legend.map(item => ({ share: share(item.count, sent), tone: item.legendTone })),
            `last request: ${tokens(request.read)} read, ${tokens(request.written)} written, ${tokens(request.fresh)} new`,
          ),
          legend.map(item => (
            <Box key={item.key} flexDirection="row" alignItems="center" columnGap={1}>
              {dot(`${item.key}-dot`, item.legendTone, item.key)}
              <Text key={`${item.key}-count`}>{tokens(item.count)}</Text>
            </Box>
          )),
        )}
        {window !== null &&
          row(
            'context',
            [
              <Text key="fill" bold color={fillTone === 'success' ? undefined : fillTone}>
                {percent(sent, window)}
              </Text>,
              <Text key="fill-note" dimColor>
                context
              </Text>,
            ],
            bar(
              'context-bar',
              [{ share: Math.min(1, fill), tone: fillTone }],
              `${tokens(sent)} of ${tokens(window)} context`,
            ),
            [
              <Text key="context-size">{tokens(sent)}</Text>,
              <Text key="context-window" dimColor>
                {`of ${tokens(window)}`}
              </Text>,
            ],
          )}
        <Box key="turn" flexDirection="row" justifyContent="space-between" columnGap={2}>
          <Text key="turn-line" dimColor wrap="truncate-end">
            {turn
              ? usageLine(`Last turn · ${turn.requests} request${turn.requests > 1 ? 's' : ''}`, turn)
              : 'Last turn · nothing yet'}
          </Text>
          <Text key="legend-names" dimColor>
            last request: read · written · new
          </Text>
        </Box>
        {turn && (
          <Text key="turn-cost" dimColor wrap="truncate-end">
            {savingLine('Last turn', turn)}
          </Text>
        )}
        <Text key="session-line" dimColor wrap="truncate-end">
          {`${usageLine(`Session · ${totals.turns} turn${totals.turns === 1 ? '' : 's'}`, totals)}${rebuildList(totals.rebuilds)}`}
        </Text>
        <Text key="session-cost" dimColor wrap="truncate-end">
          {savingLine('Session', totals)}
        </Text>
        {alert && (
          <Text key="alert" color="warning" wrap="truncate-end">
            {alert}
          </Text>
        )}
      </Box>
    )

    const mine = (
      <Box key="cache-meter" flexDirection="column" rowGap={expanded ? 1 : 0}>
        {strip}
        {expanded && details}
      </Box>
    )

    // Another mod's band stays on top, this one next to the prompt; the engine's own placeholder is left out
    const below = await next(e)
    if (below.type === 'engine') {
      return mine
    }

    // Bands stacked as the other mods stack them: each framed like the prompt box, a row apart, so they read apart;
    // a stack another mod already framed (key band-stack) is joined rather than framed again
    const stacked = (below as { props?: { key?: string } }).props?.key === 'band-stack'

    return (
      <Box key="band-stack" flexDirection="column" rowGap={1}>
        {stacked ? (
          (below as { children?: RenderElement[] }).children
        ) : (
          <Box key="upper" flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={1}>
            {below}
          </Box>
        )}
        <Box key="cache-meter-frame" flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={1}>
          {mine}
        </Box>
      </Box>
    )
  })
}
