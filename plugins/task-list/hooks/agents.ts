import type { AgentStatus } from 'claude-code'

import type { PlanTask, TrackedAgent } from '../types'

// The background agents beside the task list: what each is doing, matched to the plan task it works on

// An agent that acted this recently is working right now: its marker spins
export const ACTIVE_MS = 30_000
// One quiet this long while still running looks stuck: its line turns amber
export const STUCK_MS = 5 * 60_000
// A just-started agent the engine does not list yet is kept this long
export const GRACE_MS = 60_000
// Running only: a finished subagent that could be resumed stays listed as waiting or idle
export const ALIVE: readonly AgentStatus[] = ['pending', 'running']

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
export const SPINNER_SVG =
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
export const describeAction = (tool: string, input: Readonly<Record<string, unknown>>): string => {
  const name = tool.startsWith('mcp__') ? (tool.split('__').pop() ?? tool) : tool
  const text = (key: string): string | null => (typeof input[key] === 'string' ? (input[key] as string) : null)
  const path = text('file_path') ?? text('notebook_path') ?? text('path')
  if (path) {
    return `${name} ${shortPath(path)}`
  }
  // A Bash call says what it does in its description; else its command, past the `cd <dir> &&` that opens it
  const command = text('command')?.replace(/^(\s*cd\s+\S+\s*(&&|;)\s*)+/, '') ?? null
  const detail = (name === 'Bash' ? text('description') : null) ?? command ?? text('pattern') ?? text('description') ?? text('url') ?? text('query')

  return detail ? `${name}: ${shorten(detail, 40)}` : name
}

// A tool call still running (a test suite, a build) keeps its agent active however long it takes
export const isBusy = (agent: TrackedAgent): boolean => (agent.toolsRunning ?? 0) > 0
export const isActive = (agent: TrackedAgent, at: number): boolean => isBusy(agent) || at - agent.lastAt < ACTIVE_MS
export const isStuck = (agent: TrackedAgent, at: number): boolean => !isBusy(agent) && at - agent.lastAt >= STUCK_MS

const minutes = (ms: number): number => Math.max(0, Math.floor(ms / 60_000))
const span = (ms: number): string => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : `${minutes(ms)} min`)
const ago = (ms: number): string => `${span(ms)} ago`

// „Bash: ./run test · 6 min so far“ while the call runs, „Edit …/a/b · 9 s ago“ after
const lastStep = (agent: TrackedAgent, quiet: number): string =>
  `${agent.lastAction} · ${isBusy(agent) ? `${span(quiet)} so far` : ago(quiet)}`

// „builder · running 5 min · Bash: npx vitest run · 9 s ago“; under a task the agent goes by its role, without the
// task it repeats
export const agentText = (agent: TrackedAgent, at: number, name: string = agent.description): string => {
  const quiet = at - agent.lastAt
  const running = `${name} · running ${minutes(at - agent.startedAt)} min`
  if (isStuck(agent, at)) {
    return `${running} · no activity for ${minutes(quiet)} min`
  }

  return agent.lastAction ? `${running} · ${lastStep(agent, quiet)}` : running
}

// Which plan tasks an agent works on, from its description (`Plan 10 Task 10: referral invites`, `Review Plan 11
// tasks 1–4`, `Tasks 2, 3 and 5`): the tasks named that the running plan has, when the description names no other plan
export const tasksOfAgent = (description: string, planName: string, tasks: readonly PlanTask[]): number[] => {
  const named = description.match(/\bTasks?\s+(\d+(?:\s*(?:[,&+–—-]|and|to)\s*\d+)*)/i)?.[1]
  if (named === undefined) {
    return []
  }
  const agentPlan = description.match(/\bPlan\s+([0-9][\w.]*)/i)?.[1]
  const runningPlan = planName.match(/\bPlan\s+([0-9][\w.]*)/i)?.[1]
  if (agentPlan !== undefined && runningPlan !== undefined && agentPlan.toLowerCase() !== runningPlan.toLowerCase()) {
    return []
  }

  // `1–4` and `1 to 4` are ranges, the rest single tasks
  const numbers: number[] = []
  for (const [, from, to] of named.matchAll(/(\d+)(?:\s*(?:[–—-]|to)\s*(\d+))?/gi)) {
    const first = Number(from)
    const last = to === undefined ? first : Math.max(first, Number(to))
    for (let n = first; n <= last; n++) {
      numbers.push(n)
    }
  }

  return numbers.filter(n => tasks.some(task => task.n === n))
}

// Under its task the agent's line names what it does there: „Plan 10 Task 10: referral invites“ → „referral invites“
export const roleUnderTask = (description: string): string => {
  const rest = description.replace(/^.*?\bTask\s+\d+\b\s*[:—–-]?\s*/i, '').trim()

  return rest === '' ? description : rest
}

// What an agent is doing, for the folded line: „referral rework · Edit …/ReferralCard.tsx · 4 s ago“
export const agentActivity = (agent: TrackedAgent, at: number, name: string): string => {
  const quiet = at - agent.lastAt
  if (isStuck(agent, at)) {
    return `${name} · no activity for ${minutes(quiet)} min`
  }

  return agent.lastAction ? `${name} · ${lastStep(agent, quiet)}` : `${name} · started`
}
