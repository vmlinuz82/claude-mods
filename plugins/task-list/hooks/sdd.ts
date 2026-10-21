import type { PhaseGroup, PlanRow, PlanTask, PlanView, TaskStatus } from '../types'

// Reads superpowers' subagent-driven-development files: the plan
// (docs/superpowers/plans/*.md, `### Task N: title` headings) and the plan's ledger
// (.superpowers/sdd/<plan>/progress.md, `Task N: …` lines, `Task N: complete` when done)

export type PlanHeading = { n: number; title: string }
// isOnHold: deferred by a ledger line (`Ruling: Task 6 … deferred to after Task 7`) and not moved since
export type LedgerTask = { isComplete: boolean; step?: string; isOnHold?: true }
// isMerged: a `MERGED …` line — the plan is finished, every task done
export type Ledger = { plan: string | null; tasks: Record<number, LedgerTask>; isMerged?: true }

// What the loader reads the disk with; never rejects: a missing path is null, [] or false
export type Files = {
  read: (path: string) => Promise<string | null>
  list: (path: string) => Promise<{ name: string; kind: string; mtimeMs: number }[]>
  exists: (path: string) => Promise<boolean>
}

const TASK_HEADING = /^#+\s+Task\s+(\d+)\b[:.\s—–-]*(.*)$/
const REVIEW_PROBLEM = /❌|changes (needed|requested)|not ready/i
const NOTE = /^\s*:\s*(ruling|minor|parked|note)\b/i
const DEFERRAL = /\bdefer(red|s)?\b|\bon hold\b/i
const LEDGER_IDENTITY = /^# SDD ledger — plan:\s*(.+?)\s*$/
// A ledger line, bare or as a list item (`- Task 3: …`): controllers write it both ways
// …or one entry for several tasks: `Tasks 1–4: review dispatched`, `Tasks 2, 3 and 5: complete`
const LEDGER_TASK = /^\s*(?:[-*+]\s+)?Tasks?\s+(\d+(?:\s*(?:[,&+–—-]|and|to)\s*\d+)*)\b(.*)$/

// The tasks a `1–4`, `1 to 4` or `2, 3 and 5` names: a range is every task in it
export const taskNumbers = (named: string): number[] =>
  [...named.matchAll(/(\d+)(?:\s*(?:[–—-]|to)\s*(\d+))?/gi)].flatMap(([, from, to]) => {
    const first = Number(from)
    const last = to === undefined ? first : Math.max(first, Number(to))

    return Array.from({ length: last - first + 1 }, (_, at) => first + at)
  })
const PHASE_IN_PARENS = /\s*\(Phase\s+([0-9][\w.]*)\)/
const PHASE_PREFIX = /^.*?\bPhase\s+([0-9][\w.]*)\s*[·—–:-]?\s*(.*)$/
const IMPLEMENTATION_PLAN = /[\s—–-]*Implementation Plan\s*$/

// A ledger line's step, most specific first; null for a line that is no step (minor, ruling, carry)
const STEPS: [RegExp, (match: RegExpMatchArray) => string][] = [
  [/\bfix round (\d+)/i, match => `fix round ${match[1]}`],
  [/\bre-review\b/i, () => 're-review'],
  // A review still to come (`implemented, review pending`, `awaiting review`) is not one under way
  [/(?<!\b(awaiting|needs|before|for|to)\s+)\breview(er)?\b(?!\s+(pending|next|later|queued|due))/i, () => 'review'],
  // The implementer's report (`Task 5: DONE — …`, `DONE_WITH_CONCERNS`), upper case as superpowers writes it
  [/\bDONE(_WITH_CONCERNS)?\b/, () => 'implemented'],
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

// One task's entry after a ledger part about it; undefined when the part only names it in passing
const nextEntry = (known: LedgerTask | undefined, rest: string, isLineStart: boolean): LedgerTask | undefined => {
  // The task moves again: no longer on hold
  const { isOnHold: _wasOnHold, ...task } = known ?? { isComplete: false }
  // Done at `Task N: complete` (or `Task N complete`), or at an approved review with no problem reported beside it:
  // some controllers write no complete line after `Task 1 review: APPROVED`
  if (/^\s*:?\s*complete\b/i.test(rest)) {
    return { ...task, isComplete: true }
  }

  // A note on the task (`Task 2: Ruling: …`, `Task 1: minor (deferred): …`) is no step of it
  const step = NOTE.test(rest) ? null : stepOf(rest)
  const isApproved = /\bapproved\b/i.test(rest) && !REVIEW_PROBLEM.test(rest)
  // Mid-line, a task is named in passing (`…; Task 17 added to Plan 10`) unless the part records a step of it
  if (!isLineStart && step === null && !isApproved && known === undefined) {
    return undefined
  }
  const moved = step === null ? task : { ...task, step }

  return isApproved ? { ...moved, isComplete: true } : moved
}

export const parseLedger = (text: string): Ledger => {
  const lines = text.split('\n')
  const plan = lines[0]?.match(LEDGER_IDENTITY)?.[1] ?? null
  const tasks: Record<number, LedgerTask> = {}

  // A line may hold several events (`Scoped re-review dispatched; Task 4 dispatched in parallel`): each part
  // starting `Task N` opens a segment of that task, and the parts after it stay with it
  const segments = lines.flatMap(line =>
    // `;` separates events, and so does a sentence break before an entry `Task N:`, `Task N complete` or `Task N dispatched` (`Task 23: complete. Task 37: complete.`);
    // prose that names a task (`… precedes it. Task 6 must hoist it`) is no entry
    line.split(/;|\.\s+(?=Task\s+\d+\s*(?::|complete\b|dispatched\b))/).reduce<{ text: string; isLineStart: boolean }[]>(
      (parts, part) => {
        if (LEDGER_TASK.test(part) || parts.length === 0) {
          return [...parts, { text: part, isLineStart: parts.length === 0 }]
        }
        const last = parts[parts.length - 1] as { text: string; isLineStart: boolean }

        return [...parts.slice(0, -1), { ...last, text: `${last.text};${part}` }]
      },
      [],
    ),
  )

  for (const { text: segment, isLineStart } of segments) {
    const match = segment.match(LEDGER_TASK)
    if (!match) {
      // A ruling that defers a task puts it on hold (`Ruling: Task 6 I1 … deferred to after Task 7`)
      const held = DEFERRAL.test(segment) ? Number(segment.match(/\bTask\s+(\d+)/)?.[1]) : NaN
      const heldTask = tasks[held]
      if (heldTask && !heldTask.isComplete) {
        tasks[held] = { ...heldTask, isOnHold: true }
      }
      continue
    }
    const rest = match[2] ?? ''
    // `Task 1 → Task 2 carry: …` is a note between tasks, not a step of either
    if (/^\s*→/.test(rest)) {
      continue
    }
    for (const n of taskNumbers(match[1] ?? '')) {
      const entry = nextEntry(tasks[n], rest, isLineStart)
      if (entry) {
        tasks[n] = entry
      }
    }
  }

  // `MERGED …` or `Plan 8 MERGED …`, upper case: a lower-case „Ready to merge“ is only a review verdict
  const isMerged = lines.some(line => /\bMERGED\b/.test(line))

  return isMerged ? { plan, tasks, isMerged } : { plan, tasks }
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
    if (entry?.isComplete || ledger.isMerged) {
      return { n, title, status: 'completed' }
    }
    if (entry === undefined) {
      return { n, title, status: 'pending' }
    }

    // Tasks may run in parallel: each open task is in progress unless the ledger deferred it
    const status = entry.isOnHold ? 'on_hold' : 'in_progress'

    return entry.step === undefined ? { n, title, status } : { n, title, status, step: entry.step }
  })
  // A task implemented but never reviewed, while a later task is already under way, is not being worked on
  const newestStarted = Math.max(0, ...tasks.filter(task => task.status !== 'pending').map(task => task.n))

  return tasks.map(task =>
    task.status === 'in_progress' && task.step === 'implemented' && task.n < newestStarted ? { ...task, status: 'unreviewed' } : task,
  )
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
// What preparing a plan writes: its ledger, the plan's path and the task briefs. A workspace holding nothing else,
// with no task in its ledger, is prepared but not started
const PREPARED_FILE = /^(progress\.md|plan-path|task-\d+-brief\.md)$/

type Found = { ledger: Ledger; mtimeMs: number; isStarted: boolean }

// The ledger of the plan being worked on: the newest started one while it is open. A plan prepared ahead (its
// workspace and briefs written before the running plan is done) waits its turn: it is current only once the
// latest started plan is finished, the oldest prepared one first
const currentLedger = async (files: Files, sdd: string, root: string): Promise<Found | null> => {
  const dirs = (await files.list(sdd)).filter(entry => entry.kind === 'dir')
  const found: Found[] = []
  for (const dir of dirs) {
    const entries = await files.list(`${sdd}/${dir.name}`)
    const file = entries.find(entry => entry.name === 'progress.md' && entry.kind === 'file')
    const text = file ? await files.read(`${sdd}/${dir.name}/progress.md`) : null
    const ledger = text === null ? null : parseLedger(text)
    if (file && ledger?.plan) {
      const isStarted = Object.keys(ledger.tasks).length > 0 || entries.some(entry => !PREPARED_FILE.test(entry.name))
      found.push({ ledger, mtimeMs: file.mtimeMs, isStarted })
    }
  }

  const newestFirst = found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const [latest, before] = newestFirst.filter(one => one.isStarted)
  if (latest && (await isOpenPlan(files, root, latest.ledger))) {
    return latest
  }
  // Prepared since the started plan before the latest: older preparations were left
  const next = newestFirst.filter(one => !one.isStarted && one.mtimeMs > (before?.mtimeMs ?? -Infinity)).pop()

  return next ?? latest ?? null
}

const planPathOf = (root: string, named: string): string => (named.startsWith('/') ? named : `${root}/${named}`)

const isOpenPlan = async (files: Files, root: string, ledger: Ledger): Promise<boolean> => {
  const text = ledger.plan ? await files.read(planPathOf(root, ledger.plan)) : null

  return text !== null && planStatus(planTasks(parsePlan(text).tasks, ledger), ledger) !== 'completed'
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
    const status = planStatus(tasks, ledger)
    // One plan runs at a time, the newest ledger's: another plan with open tasks was left open, not worked on
    const isLeftOpen = !isCurrent && status === 'in_progress'
    rows.push(
      isLeftOpen
        ? { phase, name: name || file, status: 'on_hold', isCurrent, tasks: tasks.map(task => (task.status === 'in_progress' ? { ...task, status: 'on_hold' } : task)) }
        : { phase, name: name || file, status, isCurrent, tasks },
    )
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

  const current = await currentLedger(files, `${root}/.superpowers/sdd`, root)
  const named = current?.ledger.plan
  if (current === null || !named) {
    return null
  }

  const { ledger, mtimeMs } = current
  const planPath = planPathOf(root, named)
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
  const running = view.tasks.filter(one => one.status === 'in_progress')
  const task = running[0] ?? view.tasks.find(one => one.status === 'pending') ?? view.tasks[view.tasks.length - 1]
  const taskAt = task ? view.tasks.indexOf(task) + 1 : 0
  const parallel = running.length > 1 ? ` (+${running.length - 1} in parallel)` : ''
  const crumbs = [
    `Plan (${planAt}/${planCount})`,
    `Task (${taskAt}/${view.tasks.length})${task ? ` ${task.title}${task.step ? ` · ${task.step}` : ''}${parallel}` : ''}`,
  ]
  if (view.phase !== null && group) {
    crumbs.unshift(`Phase ${view.phase} (${phases.indexOf(group) + 1}/${phases.length})`)
  }

  return crumbs.join(' \\ ')
}
