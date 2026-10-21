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
    // A review still to come: the task is implemented
    ['Task 4: implemented, review pending (backend 8919b53; WatchListSearchTest 17 OK)', 'implemented'],
    ['Task 4: DONE, awaiting review', 'implemented'],
  ]

  for (const [line, step] of cases) {
    expect(parseLedger(line).tasks[4]?.step).toBe(step)
  }
})

test('parseLedger applies an entry for a range or list of tasks to each of them', () => {
  const ledger = parseLedger(
    [
      'Task 1: implemented, review pending (backend 8919b53)',
      'Task 4: implemented, review pending (frontend 4d157b6)',
      'Tasks 1–4: review dispatched (opus, read-only)',
      'Tasks 1–4: fix round 1 dispatched (findings 1–12)',
      'Tasks 2, 3 and 5: complete',
    ].join('\n'),
  )
  expect(ledger.tasks).toEqual({
    1: { isComplete: false, step: 'fix round 1' },
    2: { isComplete: true, step: 'fix round 1' },
    3: { isComplete: true, step: 'fix round 1' },
    4: { isComplete: false, step: 'fix round 1' },
    5: { isComplete: true },
  })
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

test('loadPlanView keeps the running plan current while the next one is only prepared, and takes them in turn', async () => {
  const ledger = (plan: string, lines = '') => `# SDD ledger — plan: docs/superpowers/plans/${plan}.md\n${lines}`
  const disk = {
    [`${PLANS}/2026-10-21-feedback.md`]: { text: '# User feedback Implementation Plan\n### Task 1: Store messages' },
    [`${PLANS}/2026-10-21-watch-archive.md`]: { text: '# Watch archive and search Implementation Plan\n### Task 1: Search\n### Task 2: Archive' },
    [`${PLANS}/2026-10-21-multi-shop.md`]: { text: '# One product, many shops Implementation Plan\n### Task 1: Groups' },
    [`${SDD}/2026-10-21-feedback/progress.md`]: { text: ledger('2026-10-21-feedback', 'Task 1: complete'), mtimeMs: 100 },
    // Started: no task entry yet, but an agent's report is there
    [`${SDD}/2026-10-21-watch-archive/progress.md`]: { text: ledger('2026-10-21-watch-archive'), mtimeMs: 200 },
    [`${SDD}/2026-10-21-watch-archive/task-1-brief.md`]: { text: '', mtimeMs: 200 },
    [`${SDD}/2026-10-21-watch-archive/tasks-1-2-report.md`]: { text: '', mtimeMs: 250 },
    // Prepared ahead, written last
    [`${SDD}/2026-10-21-multi-shop/progress.md`]: { text: ledger('2026-10-21-multi-shop', 'Starts after the archive is merged.'), mtimeMs: 300 },
    [`${SDD}/2026-10-21-multi-shop/plan-path`]: { text: '', mtimeMs: 300 },
    [`${SDD}/2026-10-21-multi-shop/task-1-brief.md`]: { text: '', mtimeMs: 300 },
  }
  expect((await loadPlanView(memoryFiles(disk), '/repo', NOW))?.name).toBe('Watch archive and search')

  // Both prepared after a finished plan: the one written first is next
  const queued = Object.fromEntries(Object.entries(disk).filter(([path]) => !path.endsWith('report.md')))
  expect((await loadPlanView(memoryFiles(queued), '/repo', NOW))?.name).toBe('Watch archive and search')

  // The archive done: the prepared plan takes over
  const done = { ...disk, [`${SDD}/2026-10-21-watch-archive/progress.md`]: { text: ledger('2026-10-21-watch-archive', 'Task 1: complete\nTask 2: complete'), mtimeMs: 400 } }
  expect((await loadPlanView(memoryFiles(done), '/repo', NOW))?.name).toBe('One product, many shops')
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

test('parseLedger reads ledger lines written as list items', () => {
  const ledger = [
    '# SDD ledger — plan: docs/superpowers/plans/2026-10-15-poevtini-phase7-plan4-backoffice.md',
    '## Progress',
    '- Task 1: dispatched (BASE backend 08236d5, frontend 2f37afa)',
    '- Task 1: complete (backend 08236d5..d733a86, review clean)',
    '* Task 2: dispatched (BASE frontend 5433390)',
    '- Task 2: fix round 1/5 (8 addressed, 0 open; commits 5d66e0d..ed80d9b)',
    '  - Task 3: implementer DONE 24ed346 (123 tests)',
    '- Ruling: accept phpdocumentor/type-resolver — cost if wrong: one extra library',
  ].join('\n')

  expect(parseLedger(ledger).tasks).toEqual({
    1: { isComplete: true, step: 'implementing' },
    2: { isComplete: false, step: 'fix round 1' },
    3: { isComplete: false, step: 'implemented' },
  })
})

test('an open task with a later task started is on hold; the breadcrumb follows the newest task', async () => {
  const ledger = parseLedger(
    [
      '# SDD ledger — plan: docs/superpowers/plans/x.md',
      'Task 1: complete (a..b)',
      'Task 2 review: spec ❌ / Changes needed (0C/2I/5M)',
      'Ruling: Task 2 I1 deferred to after Task 3',
      'Task 3: dispatched (BASE backend 9a956ff)',
    ].join('\n'),
  )
  const headings = [
    { n: 1, title: 'Backend' },
    { n: 2, title: 'Smoke test' },
    { n: 3, title: 'Clicks per product' },
    { n: 4, title: 'Docs' },
  ]

  expect(planTasks(headings, ledger)).toEqual([
    { n: 1, title: 'Backend', status: 'completed' },
    { n: 2, title: 'Smoke test', status: 'on_hold', step: 'review' },
    { n: 3, title: 'Clicks per product', status: 'in_progress', step: 'implementing' },
    { n: 4, title: 'Docs', status: 'pending' },
  ])

  const tasks = planTasks(headings, ledger)
  const view = { isRunning: true, phase: null, name: 'X', tasks, groups: [{ phase: null, plans: [{ name: 'X', status: 'in_progress' as const, isCurrent: true, tasks }] }] }
  expect(breadcrumb(view)).toBe('Plan (1/1) \\ Task (3/4) Clicks per product · implementing')
})

test('parseLedger reads each `;` part of a line, so a task started mid-line counts', () => {
  const ledger = [
    '# SDD ledger — plan: docs/superpowers/plans/2026-10-19-poevtini-plan8-prototype-fidelity.md',
    'Task 3: review ✅/Changes needed — M2 (test gaps) L4. Fix round 1: M1, M2, Lows.',
    'Note for T4: add an awaiting_verification row to provideStaleness.',
    'Scoped re-review dispatched; Task 4 dispatched in parallel (BASE backend b766f50, frontend ba28234).',
    'Task 3: re-review Approved.',
    'Task 3: complete (backend 500b060..b766f50)',
    'Ruling: Task 5 is deferred to after Task 6; nothing else',
  ].join('\n')

  expect(parseLedger(ledger).tasks).toEqual({
    3: { isComplete: true, step: 're-review' },
    4: { isComplete: false, step: 'implementing' },
  })
})

test('tasks run in parallel stay in progress; only a deferred task is on hold, until it moves again', () => {
  const headings = [35, 36, 37, 38].map(n => ({ n, title: `T${n}` }))
  const parallel = parseLedger(
    [
      '# SDD ledger — plan: docs/superpowers/plans/2026-10-19-poevtini-plan8-prototype-fidelity.md',
      'Task 38: complete (backend 483c168..9ebaecd)',
      'Task 35: implementer DONE_WITH_CONCERNS — backend b9e7421 (5903 OK). Opus reviewer dispatched (concern 6).',
      'Owner (2026-10-20): run other tasks in parallel. Ruling: Task 36 split — 36-admin and 36-client run now in parallel with the Task 35 review.',
      'Task 36-admin and 36-client: implementers dispatched in parallel (sonnet) — BASE frontend c269f82; shared e2e lock.',
    ].join('\n'),
  )
  expect(planTasks(headings, parallel).map(task => [task.n, task.status, task.step])).toEqual([
    [35, 'in_progress', 'review'],
    [36, 'in_progress', 'implementing'],
    [37, 'pending', undefined],
    [38, 'completed', undefined],
  ])

  const deferred = [
    '# SDD ledger — plan: docs/superpowers/plans/x.md',
    'Task 35 review: spec ❌ / Changes needed (0C/2I/5M)',
    'Task 35: minor (deferred): no StrictMode test — a minor finding, not the task',
    'Ruling: Task 35 I1 (screenshots incomplete) deferred to after Task 36 — one e2e session covers both',
    'Task 36: dispatched (BASE backend 9a956ff)',
  ]
  expect(planTasks(headings, parseLedger(deferred.join('\n'))).map(task => task.status)).toEqual(['on_hold', 'in_progress', 'pending', 'pending'])
  // Its deferred work resumes: in progress again
  const resumed = [...deferred, 'Task 36: complete (a..b)', 'Task 35: fix round 1 dispatched (resume implementer)']
  expect(planTasks(headings, parseLedger(resumed.join('\n'))).map(task => [task.status, task.step])).toEqual([
    ['in_progress', 'fix round 1'],
    ['completed', undefined],
    ['pending', undefined],
    ['pending', undefined],
  ])
})

test('the breadcrumb names the first task in progress and counts the others running in parallel', () => {
  const tasks = planTasks(
    [35, 36, 37].map(n => ({ n, title: `T${n}` })),
    parseLedger('Task 35: reviewer dispatched\nTask 36: dispatched'),
  )
  const view = { isRunning: true, phase: null, name: 'X', tasks, groups: [{ phase: null, plans: [{ name: 'X', status: 'in_progress' as const, isCurrent: true, tasks }] }] }

  expect(breadcrumb(view)).toBe('Plan (1/1) \\ Task (1/3) T35 · review (+1 in parallel)')
})

test('a deferred minor finding does not put its task on hold', () => {
  const ledger = parseLedger('Task 2: dispatched\nTask 2: minor (deferred): no StrictMode test; failed logout invisible')

  expect(planTasks([{ n: 2, title: 'T2' }], ledger)).toEqual([{ n: 2, title: 'T2', status: 'in_progress', step: 'implementing' }])
})

test('a task line that mentions deferred findings still counts; text after a ; stays with its task', () => {
  const ledger = parseLedger(
    [
      'Task 5: fix round 1/5 (suite uncollectable) then round 2/5 (3 cli tests, not 1);',
      'Task 5: complete (commits f139c3f..ead328c, review clean, 2 minors deferred)',
      'Task 12: dispatched',
      'Task 12: DEFERRED for final review — no backoff on a persistently failing source',
      'Task 35: implementer DONE_WITH_CONCERNS — backend b9e7421 (5903 OK). Accepted: singular grammar for 1 product; 6-hour job uses a real activation; re-activation keeps existing targets. Opus reviewer dispatched (concern 6).',
    ].join('\n'),
  )

  expect(ledger.tasks).toEqual({
    5: { isComplete: true, step: 'fix round 1' },
    12: { isComplete: false, step: 'review' },
    35: { isComplete: false, step: 'review' },
  })
})

test('an arrow later in a task line does not hide the line', () => {
  const ledger = parseLedger(
    'Task 3: implementer DONE 24ed346 (123 tests; code check extracted to src/lib/code.ts; 410 on accept → invalid-link view)\nTask 1 → Task 2 carry: WatchStatus docblock',
  )

  expect(ledger.tasks).toEqual({ 3: { isComplete: false, step: 'implemented' } })
})

test('a MERGED line marks every task of the plan done', () => {
  const ledger = parseLedger(
    [
      '# SDD ledger — plan: docs/superpowers/plans/2026-10-16-poevtini-phase7-plan5-client-area.md',
      'Task 6: complete (a..b)',
      'Task 7: dispatched (sonnet)',
      'Follow-up re-review: Ready to merge (0I/4M parked).',
      'MERGED 2026-10-16: ff main — infra b91e199, backend 3965ad4, frontend b6ec7c8.',
    ].join('\n'),
  )
  const headings = [6, 7, 8].map(n => ({ n, title: `T${n}` }))

  expect(planTasks(headings, ledger).map(task => task.status)).toEqual(['completed', 'completed', 'completed'])
})

test('a plan before the running one with open tasks shows left open, never in progress', async () => {
  const disk = {
    ...PHASE_7_DISK,
    // Plan 2 has a ledger with an open task and no MERGED line
    [`${SDD}/2026-10-13-phase7-plan2-tools/progress.md`]: {
      text: '# SDD ledger — plan: docs/superpowers/plans/2026-10-13-phase7-plan2-tools.md\nTask 1: dispatched',
      mtimeMs: 200,
    },
  }
  const view = await loadPlanView(memoryFiles(disk), '/repo', NOW)
  const plan2 = view?.groups.find(group => group.phase === '7')?.plans[1]

  expect([plan2?.name, plan2?.status, plan2?.tasks.map(task => task.status)]).toEqual(['Plan 2 — User Tools', 'on_hold', ['on_hold']])
})

test('a task completed in a later sentence of a line counts, and MERGED counts anywhere in a line', () => {
  const sentences = parseLedger('Task 36: dispatched\nTask 23: complete. Task 37: complete. All plan tasks complete → final whole-branch review.')
  expect(sentences.tasks).toEqual({
    23: { isComplete: true },
    36: { isComplete: false, step: 'implementing' },
    37: { isComplete: true },
  })
  expect(sentences.isMerged).toBe(undefined)

  // Prose naming a task mid-line is no entry for it
  expect(parseLedger('the benefit shrinks with however much markup precedes it. Task 6 must hoist it into the head').tasks).toEqual({})

  const merged = parseLedger('Task 36: dispatched\nPlan 8 MERGED (owner chose 1, 2026-10-20): infra main c070d61, backend main 7a52ba4.')
  expect(merged.isMerged).toBe(true)
  // „Ready to merge“ is a review verdict, not a merge
  expect(parseLedger('Follow-up re-review: Ready to merge (0I/4M parked).').isMerged).toBe(undefined)
})

test('a task is done at an approved review or at `Task N complete` written without a colon', () => {
  const ledger = parseLedger(
    [
      'Task 1: DONE_WITH_CONCERNS — eeb7772 (WatchLifetimeTest 13 OK, lint clean)',
      'Task 1 review: APPROVED (minor, carried to the final wave: VerifyEmailControllerTest message says a year)',
      'Task 2: review fix — backend 614a495 (tests 169 OK, lint clean). Task 2 complete (backend 56aba02..614a495).',
      'Task 3: fix round — backend a280be4 (trial query moved). Task 3 complete (f680dea..a280be4). Task 4 next.',
      'Task 5: DONE — backend 4d8159f (trial starts on verify)',
      'Task 6: review (opus) ❌/Changes needed — the choice is read outside the lock; quality approved otherwise',
      'Task 7 review: spec ✅, quality approved (Minor only)',
      'Task 8 re-review 1: Approved',
      'Task 9 review: Not ready (0C/1I/3M)',
    ].join('\n'),
  )
  const done = (n: number) => ledger.tasks[n]?.isComplete ?? false

  expect([1, 2, 3, 5, 6, 7, 8, 9].map(n => [n, done(n)])).toEqual([
    [1, true],
    [2, true],
    [3, true],
    [5, false],
    [6, false],
    [7, true],
    [8, true],
    [9, false],
  ])
})

test('a later sentence `Task N dispatched` starts that task, and an implementer DONE reads as implemented', () => {
  const ledger = parseLedger(
    [
      'Task 5: DONE — backend 4d8159f (trial starts on verify; TrialStartTest 10 OK), fix 82321aa (social link branch).',
      'Task 9: DONE_WITH_CONCERNS — backend d5708c8 (EffectiveWatchLimitTest 14, full suite 6289 OK, lint clean).',
      'Task 8: DONE_WITH_CONCERNS — backend 388b421 (client 713 OK). Concerns: checkout offered to trial users). Task 10 dispatched.',
    ].join('\n'),
  )

  expect(ledger.tasks).toEqual({
    5: { isComplete: false, step: 'implemented' },
    8: { isComplete: false, step: 'implemented' },
    9: { isComplete: false, step: 'implemented' },
    10: { isComplete: false, step: 'implementing' },
  })
})

test('a task named mid-line counts only when the part records a step or a completion', () => {
  const ledger = parseLedger(
    [
      'Owner ruling (2026-10-20): Free has no „Провери сега“; Task 17 added to Plan 10; spec lines 38/44 updated.',
      'Task 2: DONE_WITH_CONCERNS — backend 56aba02; Task 16 needs the remaining time on the read.',
      'Scoped re-review dispatched; Task 4 dispatched in parallel (BASE backend b766f50).',
    ].join('\n'),
  )

  expect(Object.keys(ledger.tasks).map(Number)).toEqual([2, 4])
})

test('a task implemented with no review while a later task is under way is unreviewed', () => {
  const headings = [5, 8, 9, 10, 11].map(n => ({ n, title: `T${n}` }))
  const ledger = parseLedger(
    [
      'Task 5: DONE — backend 4d8159f',
      'Task 9: DONE_WITH_CONCERNS — backend d5708c8',
      'Task 8: DONE_WITH_CONCERNS — backend 388b421. Task 10 dispatched.',
    ].join('\n'),
  )

  expect(planTasks(headings, ledger).map(task => [task.n, task.status])).toEqual([
    [5, 'unreviewed'],
    [8, 'unreviewed'],
    [9, 'unreviewed'],
    [10, 'in_progress'],
    [11, 'pending'],
  ])
  // The newest task, just implemented with nothing after it, is still the one in progress
  expect(planTasks(headings, parseLedger('Task 10: DONE — backend aaa')).find(task => task.n === 10)?.status).toBe('in_progress')
})
