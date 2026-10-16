import type { PhaseGroup, PlanRow, PlanTask, PlanView, TaskStatus } from '../types'

// Reads superpowers' subagent-driven-development files: the plan
// (docs/superpowers/plans/*.md, `### Task N: title` headings) and the plan's ledger
// (.superpowers/sdd/<plan>/progress.md, `Task N: …` lines, `Task N: complete` when done)

export type PlanHeading = { n: number; title: string }
export type LedgerTask = { isComplete: boolean; step?: string }
export type Ledger = { plan: string | null; tasks: Record<number, LedgerTask> }

// What the loader reads the disk with; never rejects: a missing path is null, [] or false
export type Files = {
  read: (path: string) => Promise<string | null>
  list: (path: string) => Promise<{ name: string; kind: string; mtimeMs: number }[]>
  exists: (path: string) => Promise<boolean>
}

const TASK_HEADING = /^#+\s+Task\s+(\d+)\b[:.\s—–-]*(.*)$/
const LEDGER_IDENTITY = /^# SDD ledger — plan:\s*(.+?)\s*$/
// A ledger line, bare or as a list item (`- Task 3: …`): controllers write it both ways
const LEDGER_TASK = /^\s*(?:[-*+]\s+)?Task\s+(\d+)\b(.*)$/
const PHASE_IN_PARENS = /\s*\(Phase\s+([0-9][\w.]*)\)/
const PHASE_PREFIX = /^.*?\bPhase\s+([0-9][\w.]*)\s*[·—–:-]?\s*(.*)$/
const IMPLEMENTATION_PLAN = /[\s—–-]*Implementation Plan\s*$/

// A ledger line's step, most specific first; null for a line that is no step (minor, ruling, carry)
const STEPS: [RegExp, (match: RegExpMatchArray) => string][] = [
  [/\bfix round (\d+)/i, match => `fix round ${match[1]}`],
  [/\bre-review\b/i, () => 're-review'],
  [/\breview\b/i, () => 'review'],
  [/\b(dispatched|started)\b/i, () => 'implementing'],
  [/\bimplement(er|ed)\b/i, () => 'implemented'],
]

const stepOf = (rest: string): string | null => {
  for (const [pattern, name] of STEPS) {
    const match = rest.match(pattern)
    if (match) {
      return name(match)
    }
  }

  return null
}

const plainTitle = (title: string): string => title.replace(/`/g, '').trim()

export const parsePlan = (text: string): { title: string; tasks: PlanHeading[] } => {
  let title = ''
  let isInFence = false
  const tasks: PlanHeading[] = []

  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      isInFence = !isInFence
      continue
    }
    if (isInFence) {
      continue
    }
    if (title === '' && line.startsWith('# ')) {
      title = line.slice(2).trim()
      continue
    }

    const heading = line.match(TASK_HEADING)
    if (heading) {
      tasks.push({ n: Number(heading[1]), title: plainTitle(heading[2] ?? '') })
    }
  }

  return { title, tasks }
}

export const parseLedger = (text: string): Ledger => {
  const lines = text.split('\n')
  const plan = lines[0]?.match(LEDGER_IDENTITY)?.[1] ?? null
  const tasks: Record<number, LedgerTask> = {}

  for (const line of lines) {
    const match = line.match(LEDGER_TASK)
    // `Task 1 → Task 2 carry: …` is a note between tasks, not a step of either
    if (!match || line.includes('→')) {
      continue
    }

    const n = Number(match[1])
    const rest = match[2] ?? ''
    const task = tasks[n] ?? { isComplete: false }
    if (/^\s*:\s*complete\b/i.test(rest)) {
      tasks[n] = { ...task, isComplete: true }
      continue
    }

    const step = stepOf(rest)
    tasks[n] = step === null ? task : { ...task, step }
  }

  return { plan, tasks }
}

// A sub-phase (3e, 1.5) belongs to its main phase (3, 1); its own label stays at the front of the name
const inMainPhase = (label: string, name: string): { phase: string; name: string } => {
  const main = label.match(/^\d+/)?.[0] ?? label

  return { phase: main, name: label === main ? name : `${label} · ${name}` }
}

export const splitTitle = (title: string): { phase: string | null; name: string } => {
  const bare = title.replace(IMPLEMENTATION_PLAN, '')
  const inParens = bare.match(PHASE_IN_PARENS)
  if (inParens?.[1]) {
    return inMainPhase(inParens[1], bare.replace(PHASE_IN_PARENS, '').trim())
  }

  const prefixed = bare.match(PHASE_PREFIX)
  if (prefixed?.[1]) {
    return inMainPhase(prefixed[1], (prefixed[2] ?? '').trim())
  }

  return { phase: null, name: bare.trim() }
}

export const planTasks = (headings: readonly PlanHeading[], ledger: Ledger): PlanTask[] => {
  const tasks = headings.map(({ n, title }): PlanTask => {
    const entry = ledger.tasks[n]
    if (entry?.isComplete) {
      return { n, title, status: 'completed' }
    }
    if (entry === undefined) {
      return { n, title, status: 'pending' }
    }

    return entry.step === undefined ? { n, title, status: 'in_progress' } : { n, title, status: 'in_progress', step: entry.step }
  })
  // A controller may leave a task open and start the next (its fixes deferred): the newest started
  // task is the one being worked on, an earlier open one is on hold
  const newest = Math.max(...tasks.filter(task => task.status === 'in_progress').map(task => task.n))

  return tasks.map(task => (task.status === 'in_progress' && task.n < newest ? { ...task, status: 'on_hold' } : task))
}

const normalized = (text: string): string => text.trim().toLowerCase()

// Superpowers makes a todo per plan task; those repeat the tree and are left out of it
export const isPlanTodo = (content: string, tasks: readonly PlanTask[]): boolean =>
  /\btask\s+\d+\b/i.test(content) || tasks.some(task => normalized(task.title) === normalized(content))

const planStatus = (tasks: readonly PlanTask[], ledger: Ledger | null): TaskStatus => {
  if (tasks.length > 0 && tasks.every(task => task.status === 'completed')) {
    return 'completed'
  }

  return ledger !== null && Object.keys(ledger.tasks).length > 0 ? 'in_progress' : 'pending'
}

const parentOf = (path: string): string => path.slice(0, Math.max(path.lastIndexOf('/'), 0)) || '/'
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

// The folder holding .superpowers/sdd: the working directory or the nearest parent with one
const findRoot = async (files: Files, cwd: string): Promise<string | null> => {
  let dir = cwd
  for (;;) {
    if (await files.exists(`${dir}/.superpowers/sdd`)) {
      return dir
    }
    const parent = parentOf(dir)
    if (parent === dir) {
      return null
    }
    dir = parent
  }
}

// The ledger written last that names its plan: superpowers runs one plan at a time, and a ledger
// without the `# SDD ledger — plan:` line predates the format, its tasks unreadable
const newestLedger = async (files: Files, sdd: string): Promise<{ ledger: Ledger; mtimeMs: number } | null> => {
  const dirs = (await files.list(sdd)).filter(entry => entry.kind === 'dir')
  const ledgers: { path: string; mtimeMs: number }[] = []
  for (const dir of dirs) {
    const entries = await files.list(`${sdd}/${dir.name}`)
    const ledger = entries.find(file => file.name === 'progress.md' && file.kind === 'file')
    if (ledger) {
      ledgers.push({ path: `${sdd}/${dir.name}/progress.md`, mtimeMs: ledger.mtimeMs })
    }
  }

  for (const { path, mtimeMs } of ledgers.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    const text = await files.read(path)
    const ledger = text === null ? null : parseLedger(text)
    if (ledger?.plan) {
      return { ledger, mtimeMs }
    }
  }

  return null
}

// Every plan next to the running one, in file name (date) order, each with its own ledger's tasks
const allPlans = async (
  files: Files,
  root: string,
  current: { path: string; ledger: Ledger },
): Promise<(PlanRow & { phase: string | null })[]> => {
  const dir = parentOf(current.path)
  const names = (await files.list(dir))
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.md'))
    .map(entry => entry.name)
    .sort()
  const rows: (PlanRow & { phase: string | null })[] = []
  // Superpowers' workspaces are scratch and often cleaned: a plan without a ledger before the
  // running one was run before it, one after it is still to do
  let isBeforeCurrent = names.some(file => `${dir}/${file}` === current.path)

  for (const file of names) {
    const text = await files.read(`${dir}/${file}`)
    if (text === null) {
      continue
    }
    const plan = parsePlan(text)
    const { phase, name } = splitTitle(plan.title)
    const isCurrent = `${dir}/${file}` === current.path
    if (isCurrent) {
      isBeforeCurrent = false
    }
    // The running plan's ledger is known; another plan's sits in the workspace named after its file
    const ledgerText = isCurrent ? null : await files.read(`${root}/.superpowers/sdd/${file.replace(/\.md$/, '')}/progress.md`)
    const parsed = ledgerText === null ? null : parseLedger(ledgerText)
    // A ledger from before the identity line can't be read: such a plan counts as having none
    const ledger = isCurrent ? current.ledger : parsed?.plan ? parsed : null
    const tasks =
      ledger === null && isBeforeCurrent
        ? plan.tasks.map(({ n, title }): PlanTask => ({ n, title, status: 'completed' }))
        : planTasks(plan.tasks, ledger ?? { plan: null, tasks: {} })
    rows.push({ phase, name: name || file, status: planStatus(tasks, ledger), isCurrent, tasks })
  }

  return rows
}

// Plans grouped by phase; plans without one share a group
const byPhase = (rows: readonly (PlanRow & { phase: string | null })[]): PhaseGroup[] => {
  const groups: PhaseGroup[] = []
  for (const { phase, ...row } of rows) {
    const group = groups.find(one => one.phase === phase)
    if (group) {
      group.plans.push(row)
      continue
    }
    groups.push({ phase, plans: [row] })
  }

  // Phases in number order whatever the files' dates; the plans without a phase last
  return groups.sort((a, b) => (a.phase === null ? Infinity : Number(a.phase)) - (b.phase === null ? Infinity : Number(b.phase)))
}

// A plan whose ledger hasn't changed for a day is left, not running
const RUNNING_WINDOW_MS = 24 * 60 * 60 * 1000

// The newest ledger's plan and every plan beside it, or null when there is no superpowers plan
export const loadPlanView = async (files: Files, cwd: string, now: number): Promise<PlanView | null> => {
  const root = await findRoot(files, cwd)
  if (root === null) {
    return null
  }

  const newest = await newestLedger(files, `${root}/.superpowers/sdd`)
  const named = newest?.ledger.plan
  if (newest === null || !named) {
    return null
  }

  const { ledger, mtimeMs } = newest
  const planPath = named.startsWith('/') ? named : `${root}/${named}`
  const planText = await files.read(planPath)
  if (planText === null) {
    return null
  }

  const plan = parsePlan(planText)
  const tasks = planTasks(plan.tasks, ledger)
  const { phase, name } = splitTitle(plan.title)
  const groups = byPhase(await allPlans(files, root, { path: planPath, ledger }))

  return {
    // A finished or left plan is history, as a finished todo list is: the band hides it, the pane keeps it
    isRunning: tasks.length > 0 && planStatus(tasks, ledger) !== 'completed' && now - mtimeMs < RUNNING_WINDOW_MS,
    phase,
    name: name || nameOf(planPath),
    tasks,
    groups,
  }
}

// The running task in one line: Phase 7 (13/13) \ Plan (3/4) \ Task (3/7) title · step. The task is
// the one in progress, else the next to do; a plan without a phase starts at Plan
export const breadcrumb = (view: PlanView): string => {
  const phases = view.groups.filter(group => group.phase !== null)
  const group = view.groups.find(one => one.plans.some(row => row.isCurrent))
  const planAt = group ? group.plans.findIndex(row => row.isCurrent) + 1 : 1
  const planCount = group ? group.plans.length : 1
  const task =
    view.tasks.find(one => one.status === 'in_progress') ??
    view.tasks.find(one => one.status === 'pending') ??
    view.tasks[view.tasks.length - 1]
  const taskAt = task ? view.tasks.indexOf(task) + 1 : 0
  const crumbs = [
    `Plan (${planAt}/${planCount})`,
    `Task (${taskAt}/${view.tasks.length})${task ? ` ${task.title}${task.step ? ` · ${task.step}` : ''}` : ''}`,
  ]
  if (view.phase !== null && group) {
    crumbs.unshift(`Phase ${view.phase} (${phases.indexOf(group) + 1}/${phases.length})`)
  }

  return crumbs.join(' \\ ')
}
