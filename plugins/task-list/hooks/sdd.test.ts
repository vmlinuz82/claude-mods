import { expect, test } from 'claude-code/testing'

import { breadcrumb, isPlanTodo, loadPlanView, parseLedger, parsePlan, planTasks, splitTitle } from './sdd'
import { LEDGER, memoryFiles, NOW, PHASE_7_DISK, PLAN, PLANS, SDD } from './sdd.fixtures'

test('parsePlan reads the title and the task headings outside code fences', () => {
  expect(parsePlan(PLAN)).toEqual({
    title: 'Phase 7 · Plan 3 — Frontend Foundation Implementation Plan',
    tasks: [
      { n: 1, title: 'Workspace, shared tooling and packages/ui' },
      { n: 2, title: 'packages/api — OpenAPI types and the session-aware client' },
      { n: 3, title: 'The three app shells' },
    ],
  })
})

test('parseLedger reads the plan path, completions and the latest step of each task', () => {
  expect(parseLedger(LEDGER)).toEqual({
    plan: 'docs/superpowers/plans/2026-10-13-poevtini-phase7-plan3-frontend-foundation.md',
    tasks: {
      1: { isComplete: true, step: 'review' },
      2: { isComplete: false, step: 'fix round 1' },
    },
  })
  expect(parseLedger('no identity line\nTask 1: dispatched')).toEqual({ plan: null, tasks: { 1: { isComplete: false, step: 'implementing' } } })
})

test('parseLedger names each kind of step', () => {
  const cases: [string, string][] = [
    ['Task 4: dispatched (sonnet) — BASE 830527a', 'implementing'],
    ['Task 4: started (controller-run, no subagent)', 'implementing'],
    ['Task 4: implementer DONE de11cd7 (1365 tests)', 'implemented'],
    ['Task 4: fix round 1 implemented a1bbedc', 'fix round 1'],
    ['Task 4: review dispatched (sonnet)', 'review'],
    ['Task 4 review (opus): spec ❌', 'review'],
    ['Task 4 re-review 1: all 6 addressed', 're-review'],
    ['Task 4 fix round 2: dispatched (resume implementer)', 'fix round 2'],
    ['Task 4: fix round 2/5 (1 addressed, 0 open; commits a..b)', 'fix round 2'],
  ]

  for (const [line, step] of cases) {
    expect(parseLedger(line).tasks[4]?.step).toBe(step)
  }
})

test('splitTitle finds the phase and the plan name in each title style; a sub-phase joins its main phase', () => {
  const cases: [string, { phase: string | null; name: string }][] = [
    ['Phase 7 · Plan 3 — Frontend Foundation Implementation Plan', { phase: '7', name: 'Plan 3 — Frontend Foundation' }],
    ['PoEvtini.bg Phase 4 — Price Checks and Watch Expiry Implementation Plan', { phase: '4', name: 'Price Checks and Watch Expiry' }],
    ['PoEvtini.bg Phase 3e — Affiliate Links — Implementation Plan', { phase: '3', name: '3e · Affiliate Links' }],
    ['POEVTINI Infra & Foundation (Phase 1) Implementation Plan', { phase: '1', name: 'POEVTINI Infra & Foundation' }],
    ['POEVTINI Repo Split (Phase 1.5) Implementation Plan', { phase: '1', name: '1.5 · POEVTINI Repo Split' }],
    ['Anketi Foundation Implementation Plan', { phase: null, name: 'Anketi Foundation' }],
  ]

  for (const [title, expected] of cases) {
    expect(splitTitle(title)).toEqual(expected)
  }
})

test('planTasks joins the plan headings with the ledger', () => {
  expect(planTasks(parsePlan(PLAN).tasks, parseLedger(LEDGER))).toEqual([
    { n: 1, title: 'Workspace, shared tooling and packages/ui', status: 'completed' },
    { n: 2, title: 'packages/api — OpenAPI types and the session-aware client', status: 'in_progress', step: 'fix round 1' },
    { n: 3, title: 'The three app shells', status: 'pending' },
  ])
})

test('isPlanTodo spots todos that repeat a plan task', () => {
  const tasks = planTasks(parsePlan(PLAN).tasks, parseLedger(LEDGER))
  const cases: [string, boolean][] = [
    ['Task 2: packages/api', true],
    ['task 3', true],
    ['The three app shells', true],
    ['the three app shells ', true],
    ['Run the type generation', false],
    ['Taskbar icon', false],
  ]

  for (const [content, expected] of cases) {
    expect(isPlanTodo(content, tasks)).toBe(expected)
  }
})

test('loadPlanView builds every phase, plan and task from the ledgers', async () => {
  const view = await loadPlanView(memoryFiles(PHASE_7_DISK), '/repo/repositories/frontend', NOW)
  const tasks = planTasks(parsePlan(PLAN).tasks, parseLedger(LEDGER))

  expect(view).toEqual({
    isRunning: true,
    phase: '7',
    name: 'Plan 3 — Frontend Foundation',
    tasks,
    groups: [
      {
        phase: '5',
        // No ledger, filed before the running plan: done
        plans: [{ name: 'Alert Emails', status: 'completed', isCurrent: false, tasks: [{ n: 1, title: 'Mailer', status: 'completed' }] }],
      },
      {
        phase: '7',
        plans: [
          {
            name: 'Plan 1 — Admin Access',
            status: 'completed',
            isCurrent: false,
            tasks: [
              { n: 1, title: 'Roles', status: 'completed' },
              { n: 2, title: 'Audit log', status: 'completed' },
            ],
          },
          { name: 'Plan 2 — User Tools', status: 'completed', isCurrent: false, tasks: [{ n: 1, title: 'Blocking', status: 'completed' }] },
          { name: 'Plan 3 — Frontend Foundation', status: 'in_progress', isCurrent: true, tasks },
          // No ledger, filed after it: to do
          { name: 'Plan 4 — Later', status: 'pending', isCurrent: false, tasks: [{ n: 1, title: 'Next', status: 'pending' }] },
        ],
      },
    ],
  })
})

test('loadPlanView marks a finished plan as not running and finds nothing without a plan', async () => {
  const finished = {
    ...PHASE_7_DISK,
    [`${SDD}/2026-10-12-phase7-plan1-admin/progress.md`]: {
      text: '# SDD ledger — plan: docs/superpowers/plans/2026-10-12-phase7-plan1-admin.md\nTask 1: complete\nTask 2: complete',
      mtimeMs: 900,
    },
  }
  const view = await loadPlanView(memoryFiles(finished), '/repo', NOW)
  expect(view?.isRunning).toBe(false)
  expect(view?.name).toBe('Plan 1 — Admin Access')

  const empty: [string, Record<string, { text: string; mtimeMs?: number }>, string][] = [
    ['no .superpowers folder', { '/elsewhere/README.md': { text: '' } }, '/elsewhere'],
    ['the ledger names a missing plan', { [`${SDD}/x/progress.md`]: { text: '# SDD ledger — plan: docs/gone.md\nTask 1: dispatched' } }, '/repo'],
  ]
  for (const [, disk, cwd] of empty) {
    expect(await loadPlanView(memoryFiles(disk), cwd, NOW)).toBe(null)
  }
})

test('loadPlanView groups plans without a phase together', async () => {
  const disk = {
    [`${PLANS}/2026-09-13-anketi-foundation.md`]: { text: '# Anketi Foundation Implementation Plan\n### Task 1: Scaffold\n### Task 2: Models' },
    [`${PLANS}/2026-09-14-anketi-production.md`]: { text: '# Production Implementation Plan\n### Task 1: Deploy' },
    [`${SDD}/2026-09-13-anketi-foundation/progress.md`]: {
      text: '# SDD ledger — plan: docs/superpowers/plans/2026-09-13-anketi-foundation.md\nTask 1: dispatched (sonnet)',
    },
  }
  const tasks = [
    { n: 1, title: 'Scaffold', status: 'in_progress', step: 'implementing' },
    { n: 2, title: 'Models', status: 'pending' },
  ]

  expect(await loadPlanView(memoryFiles(disk), '/repo', NOW)).toEqual({
    isRunning: true,
    phase: null,
    name: 'Anketi Foundation',
    tasks,
    groups: [
      {
        phase: null,
        plans: [
          { name: 'Anketi Foundation', status: 'in_progress', isCurrent: true, tasks },
          { name: 'Production', status: 'pending', isCurrent: false, tasks: [{ n: 1, title: 'Deploy', status: 'pending' }] },
        ],
      },
    ],
  })
})

test('loadPlanView skips ledgers from before the identity line and follows the newest one with it', async () => {
  const disk = {
    ...PHASE_7_DISK,
    // An early free-form ledger, written last: its tasks can't be read, so it doesn't count
    [`${SDD}/2026-10-14-phase7-plan4-later/progress.md`]: { text: '# Plan 4 — later\nTasks 1+2: 64d3634. Plan 4 COMPLETE.', mtimeMs: 900 },
  }

  const view = await loadPlanView(memoryFiles(disk), '/repo', NOW)
  expect(view?.name).toBe('Plan 3 — Frontend Foundation')
  // …and in the tree its plan counts as having no ledger: after the running plan, to do
  expect(view?.groups[1]?.plans[3]?.status).toBe('pending')
})

test('loadPlanView counts a plan as running only while its ledger changed in the last day', async () => {
  const day = 24 * 60 * 60 * 1000
  const cases: [number, boolean][] = [
    [300 + day - 1, true],
    [300 + day + 1, false],
  ]

  for (const [now, isRunning] of cases) {
    expect((await loadPlanView(memoryFiles(PHASE_7_DISK), '/repo', now))?.isRunning).toBe(isRunning)
  }
})

test('loadPlanView counts a plan without a ledger as done before the running plan, to do after it', async () => {
  const disk = {
    ...PHASE_7_DISK,
    // Plan 1's ledger is gone, as superpowers' scratch workspace often is
    [`${SDD}/2026-10-12-phase7-plan1-admin/progress.md`]: undefined,
  }
  const view = await loadPlanView(memoryFiles(Object.fromEntries(Object.entries(disk).filter(([, file]) => file !== undefined)) as never), '/repo', NOW)
  const phase7 = view?.groups.find(group => group.phase === '7')?.plans.map(row => [row.name, row.status, row.tasks.map(task => task.status)])

  expect(phase7).toEqual([
    ['Plan 1 — Admin Access', 'completed', ['completed', 'completed']],
    ['Plan 2 — User Tools', 'completed', ['completed']],
    ['Plan 3 — Frontend Foundation', 'in_progress', ['completed', 'in_progress', 'pending']],
    ['Plan 4 — Later', 'pending', ['pending']],
  ])
})

test('breadcrumb places the task in its plan and the plan in its phase', async () => {
  const phased = await loadPlanView(memoryFiles(PHASE_7_DISK), '/repo', NOW)
  const unphased = await loadPlanView(
    memoryFiles({
      [`${PLANS}/2026-09-13-anketi-foundation.md`]: { text: '# Anketi Foundation Implementation Plan\n### Task 1: Scaffold\n### Task 2: Models' },
      [`${PLANS}/2026-09-14-anketi-production.md`]: { text: '# Production Implementation Plan\n### Task 1: Deploy' },
      [`${SDD}/2026-09-13-anketi-foundation/progress.md`]: {
        text: '# SDD ledger — plan: docs/superpowers/plans/2026-09-13-anketi-foundation.md\nTask 1: complete (a..b)',
      },
    }),
    '/repo',
    NOW,
  )

  // Phase 7 is the second of two phases; with no task in progress the next one to do shows
  expect(phased && breadcrumb(phased)).toBe(
    'Phase 7 (2/2) \\ Plan (3/4) \\ Task (2/3) packages/api — OpenAPI types and the session-aware client · fix round 1',
  )
  expect(unphased && breadcrumb(unphased)).toBe('Plan (1/2) \\ Task (2/2) Models')
})

test('sub-phases join their main phase and phases count in number order', async () => {
  // File dates put Phase 2 before Phase 1.5, and Phase 3b before Phase 3a
  const disk = {
    [`${PLANS}/2026-10-06-infra.md`]: { text: '# POEVTINI Infra & Foundation (Phase 1) Implementation Plan\n### Task 1: Compose' },
    [`${PLANS}/2026-10-07-a-phase2.md`]: { text: '# POEVTINI Phase 2 — Product Inspection Implementation Plan\n### Task 1: Inspect' },
    [`${PLANS}/2026-10-07-b-split.md`]: { text: '# POEVTINI Repo Split (Phase 1.5) Implementation Plan\n### Task 1: Split' },
    [`${PLANS}/2026-10-08-phase3b.md`]: { text: '# PoEvtini.bg Phase 3b — Watches Implementation Plan\n### Task 1: Watch' },
    [`${PLANS}/2026-10-09-phase3a.md`]: { text: '# PoEvtini.bg Phase 3a — Accounts Implementation Plan\n### Task 1: Sign up\n### Task 2: Log in' },
    [`${SDD}/2026-10-09-phase3a/progress.md`]: {
      text: '# SDD ledger — plan: docs/superpowers/plans/2026-10-09-phase3a.md\nTask 1: complete (a..b)\nTask 2: dispatched',
    },
  }
  const view = await loadPlanView(memoryFiles(disk), '/repo', NOW)

  expect(view?.groups.map(group => [group.phase, group.plans.map(row => row.name)])).toEqual([
    ['1', ['POEVTINI Infra & Foundation', '1.5 · POEVTINI Repo Split']],
    ['2', ['Product Inspection']],
    ['3', ['3b · Watches', '3a · Accounts']],
  ])
  expect(view && breadcrumb(view)).toBe('Phase 3 (3/3) \\ Plan (2/2) \\ Task (2/2) Log in · implementing')
})
