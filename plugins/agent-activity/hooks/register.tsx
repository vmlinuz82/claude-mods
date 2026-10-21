import { atom, read, update } from 'claude-code'
import type { AgentInfo, AgentStatus, EngineInterface, Register, RenderElement } from 'claude-code'

import type { TrackedAgent } from '../types'

const agents = atom({ plugin: 'agent-activity', key: 'agents' } as const, [])
const now = atom({ plugin: 'agent-activity', key: 'now' } as const, 0)
const frame = atom({ plugin: 'agent-activity', key: 'frame' } as const, 0)
const closedOn = atom({ plugin: 'agent-activity', key: 'closedOn' } as const, null)

// An agent that acted this recently is working right now: its marker spins
const ACTIVE_MS = 30_000
// One quiet this long while still running looks stuck: its line turns amber
const STUCK_MS = 5 * 60_000
// The clock is read every TICK_MS (for „12 s ago“), the engine's agent list every LIST_EVERY ticks
const TICK_MS = 5_000
const LIST_EVERY = 3
const SPIN_MS = 250
// A just-started agent the engine does not list yet is kept this long
const GRACE_MS = 60_000
// Running only: a finished subagent that could be resumed stays listed as waiting or idle
const ALIVE: readonly AgentStatus[] = ['pending', 'running']

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPINNER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">' +
  '<circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5"/>' +
  '<path d="M6 1.5a4.5 4.5 0 0 1 4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">' +
  '<animateTransform attributeName="transform" type="rotate" from="0 6 6" to="360 6 6" dur="0.9s" repeatCount="indefinite"/>' +
  '</path></svg>'

const shorten = (text: string, max: number): string => {
  const line = text.split('\n')[0] ?? ''

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const shortPath = (path: string): string => {
  const parts = path.split('/').filter(Boolean)

  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path
}

// A tool call in one line: „Edit …/profile/PlanCard.tsx“, „Bash: npx vitest run apps/client“
const describeAction = (tool: string, input: Readonly<Record<string, unknown>>): string => {
  const name = tool.startsWith('mcp__') ? (tool.split('__').pop() ?? tool) : tool
  const text = (key: string): string | null => (typeof input[key] === 'string' ? (input[key] as string) : null)
  const path = text('file_path') ?? text('notebook_path') ?? text('path')
  if (path) {
    return `${name} ${shortPath(path)}`
  }
  const detail = text('command') ?? text('pattern') ?? text('description') ?? text('url') ?? text('query')

  return detail ? `${name}: ${shorten(detail, 40)}` : name
}

const minutes = (ms: number): number => Math.max(0, Math.floor(ms / 60_000))
const ago = (ms: number): string => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} s ago` : `${minutes(ms)} min ago`)

const lineText = (agent: TrackedAgent, at: number): string => {
  const quiet = at - agent.lastAt
  const running = `${agent.description} · running ${minutes(at - agent.startedAt)} min`
  if (quiet >= STUCK_MS) {
    return `${running} · no activity for ${minutes(quiet)} min`
  }

  return agent.lastAction ? `${running} · ${agent.lastAction} · ${ago(quiet)}` : running
}

let spinner: { cancel: () => void } | null = null

// The terminal spinner steps only while some agent is active
const keepSpinning = async ($: EngineInterface): Promise<void> => {
  const at = await $.clock.now()
  const isActive = (await read($, agents)).some(agent => at - agent.lastAt < ACTIVE_MS)
  if (isActive && spinner === null) {
    spinner = $.clock.every(SPIN_MS, () => {
      void update($, frame, step => step + 1)
      void keepSpinning($)
    })
  }
  if (!isActive && spinner !== null) {
    spinner.cancel()
    spinner = null
  }
}

// The engine's list says which agents still run: finished, failed, stopped and waiting ones leave. Agents are added
// only when this mod sees them start or act, never from the list alone (it keeps finished agents for a while)
const refresh = async ($: EngineInterface): Promise<void> => {
  const at = await $.clock.now()
  const listed = await $.agent.list().catch(() => [])
  await syncAgents($, at, listed)
  await update($, now, () => at)
  await keepSpinning($)
}

let ticks = 0

const tick = async ($: EngineInterface): Promise<void> => {
  ticks += 1
  if (ticks % LIST_EVERY === 0) {
    await refresh($)
    return
  }
  const at = await $.clock.now()
  await update($, now, () => at)
}

const syncAgents = async ($: EngineInterface, at: number, listed: readonly AgentInfo[]): Promise<void> => {
  const statusOf = new Map(listed.map(agent => [agent.id, agent.status]))
  await update($, agents, followed => {
    const kept = followed.filter(agent => {
      const status = statusOf.get(agent.id)

      return status === undefined ? at - agent.startedAt < GRACE_MS : ALIVE.includes(status)
    })
    return kept
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await refresh($)
    $.clock.every(TICK_MS, () => void tick($))

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const agentId = started.agentId
    if (agentId) {
      const at = await $.clock.now()
      await update($, agents, followed => [
        ...followed.filter(agent => agent.id !== agentId),
        { id: agentId, description: e.description, startedAt: at, lastAt: at, lastAction: null },
      ])
      await update($, now, () => at)
      await keepSpinning($)
    }

    return started
  })

  // Every tool call inside an agent carries its id: the agent's latest action, and the time it acted
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      const at = await $.clock.now()
      const action = describeAction(e.tool, e as unknown as Record<string, unknown>)
      // An agent started before this mod loaded joins at its first action, named as the engine lists it
      const isKnown = (await read($, agents)).some(agent => agent.id === agentId)
      const listed = isKnown ? undefined : (await $.agent.list().catch(() => [])).find(agent => agent.id === agentId)
      await update($, agents, followed =>
        followed.some(agent => agent.id === agentId)
          ? followed.map(agent => (agent.id === agentId ? { ...agent, lastAt: at, lastAction: action } : agent))
          : [...followed, { id: agentId, description: listed?.description ?? 'Agent', startedAt: at, lastAt: at, lastAction: action }],
      )
      await update($, now, () => at)
      await keepSpinning($)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const followed = await read($, agents)
    const closed = await read($, closedOn)
    const isClosed = closed !== null && followed.every(agent => closed.includes(agent.id))
    if (e.props.hasSurvey || followed.length === 0 || isClosed) {
      return next(e)
    }

    const at = await read($, now)
    const table = $.ui.resolve(e)
    const { Box, Button, Text } = table
    // The desktop draws an animated image; the terminal, a text spinner stepped by the clock
    const svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : null
    const step = svg === null ? await read($, frame) : 0
    const mine = (
      <Box key="agent-activity" flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Box key="agents" flexDirection="column" flexShrink={1}>
          {followed.map(agent => {
            const quiet = at - agent.lastAt
            const isActive = quiet < ACTIVE_MS
            const isStuck = quiet >= STUCK_MS
            const marker = isActive ? (svg === null ? `${SPINNER[step % SPINNER.length]} ` : '') : '◼ '

            return (
              <Box key={agent.id} flexDirection="row" columnGap={1}>
                {isActive && svg !== null && h(svg, { key: 'spinner', source: SPINNER_SVG, alt: 'working', width: 12, height: 12, isInteractive: true })}
                <Text key="line" color={isStuck ? 'warning' : undefined} wrap="truncate-end">
                  {marker}
                  {lineText(agent, at)}
                </Text>
              </Box>
            )
          })}
        </Box>
        <Button
          key="close"
          label="×"
          role="dismiss"
          plain
          dimColor
          onPress={() => update($, closedOn, () => followed.map(agent => agent.id))}
        />
      </Box>
    )

    // Another mod's band beneath this one stays; each band gets a frame like the prompt box, and a stack other
    // mods already framed is joined rather than framed again
    const below = await next(e)
    if (below.type === 'engine') {
      return mine
    }

    const frameOf = (key: string, child: RenderElement) => (
      <Box key={key} flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={1}>
        {child}
      </Box>
    )
    const stacked = (below as { props?: { key?: string }; children?: RenderElement[] }).props?.key === 'band-stack'

    return (
      <Box key="band-stack" flexDirection="column" rowGap={1}>
        {stacked ? (below as { children?: RenderElement[] }).children : frameOf('upper', below)}
        {frameOf('agent-activity-frame', mine)}
      </Box>
    )
  })
}
