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
  const detail = text('command') ?? text('pattern') ?? text('description') ?? text('url') ?? text('query')

  return detail ? `${name}: ${shorten(detail, 40)}` : name
}

export const isActive = (agent: TrackedAgent, at: number): boolean => at - agent.lastAt < ACTIVE_MS
export const isStuck = (agent: TrackedAgent, at: number): boolean => at - agent.lastAt >= STUCK_MS

const minutes = (ms: number): number => Math.max(0, Math.floor(ms / 60_000))
const ago = (ms: number): string => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} s ago` : `${minutes(ms)} min ago`)

// „builder · running 5 min · Bash: npx vitest run · 9 s ago“; under a task the agent goes by its role, without the
// task it repeats
export const agentText = (agent: TrackedAgent, at: number, name: string = agent.description): string => {
  const quiet = at - agent.lastAt
  const running = `${name} · running ${minutes(at - agent.startedAt)} min`
  if (quiet >= STUCK_MS) {
    return `${running} · no activity for ${minutes(quiet)} min`
  }

  return agent.lastAction ? `${running} · ${agent.lastAction} · ${ago(quiet)}` : running
}

// Which plan task an agent works on, from its description (`Plan 10 Task 10: referral invites`, `Review Task 7`):
// the task named, when the running plan has it and the description names no other plan
export const taskOfAgent = (description: string, planName: string, tasks: readonly PlanTask[]): number | null => {
  const named = description.match(/\bTask\s+(\d+)\b/i)?.[1]
  if (named === undefined || !tasks.some(task => task.n === Number(named))) {
    return null
  }
  const agentPlan = description.match(/\bPlan\s+([0-9][\w.]*)/i)?.[1]
  const runningPlan = planName.match(/\bPlan\s+([0-9][\w.]*)/i)?.[1]

  return agentPlan !== undefined && runningPlan !== undefined && agentPlan.toLowerCase() !== runningPlan.toLowerCase()
    ? null
    : Number(named)
}

// Under its task the agent's line names what it does there: „Plan 10 Task 10: referral invites“ → „referral invites“
export const roleUnderTask = (description: string): string => {
  const rest = description.replace(/^.*?\bTask\s+\d+\b\s*[:—–-]?\s*/i, '').trim()

  return rest === '' ? description : rest
}

// What an agent is doing, for the folded line: „referral rework · Edit …/ReferralCard.tsx · 4 s ago“
export const agentActivity = (agent: TrackedAgent, at: number, name: string): string => {
  const quiet = at - agent.lastAt
  if (quiet >= STUCK_MS) {
    return `${name} · no activity for ${minutes(quiet)} min`
  }

  return agent.lastAction ? `${name} · ${agent.lastAction} · ${ago(quiet)}` : `${name} · started`
}
