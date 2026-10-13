import type { Files } from './sdd'

// Real-shaped superpowers files for the tests: a plan, its ledger, and a repo with phase 7's plans

export const PLAN = [
  '# Phase 7 · Plan 3 — Frontend Foundation Implementation Plan',
  '',
  '## Global Constraints',
  '',
  '```md',
  '### Task 9: a heading inside a code fence is not a task',
  '```',
  '',
  '### Task 1: Workspace, shared tooling and `packages/ui`',
  'text',
  '### Task 2: `packages/api` — OpenAPI types and the session-aware client',
  '## Task 3: The three app shells',
].join('\n')

export const LEDGER = [
  '# SDD ledger — plan: docs/superpowers/plans/2026-10-13-poevtini-phase7-plan3-frontend-foundation.md',
  'Spec: docs/superpowers/specs/x.md',
  '## Progress',
  'Task 1: dispatched (sonnet), BASE backend 5b79473',
  'Task 1: implementer DONE_WITH_CONCERNS 5efb879 (1302 tests)',
  'Task 1 review: spec ✅, quality approved (Minor only)',
  'Task 1: complete (backend 5b79473..5efb879, review clean)',
  'Task 1: minor (deferred): WatchTest asserts a fuzzy expiry window',
  'Task 1 → Task 2 carry: WatchStatus docblock says every status counts',
  'Task 2: dispatched (sonnet), BASE backend 5efb879',
  'Task 2 review: spec ❌ (create at the plan limit)',
  'Task 2: fix round 1/5 dispatched (resume implementer)',
  'Task 2: Ruling: the reviewer misread the plan — the code stands',
].join('\n')

// An in-memory disk: each file's text and modification time, folders implied by the paths
export const memoryFiles = (disk: Record<string, { text: string; mtimeMs?: number }>): Files => ({
  read: async path => disk[path]?.text ?? null,
  exists: async path => Object.keys(disk).some(file => file === path || file.startsWith(`${path}/`)),
  list: async path => {
    const entries = new Map<string, { name: string; kind: string; mtimeMs: number }>()
    for (const [file, { mtimeMs }] of Object.entries(disk)) {
      if (!file.startsWith(`${path}/`)) {
        continue
      }
      const [name = '', ...deeper] = file.slice(path.length + 1).split('/')
      entries.set(name, { name, kind: deeper.length > 0 ? 'dir' : 'file', mtimeMs: deeper.length > 0 ? 0 : mtimeMs ?? 0 })
    }

    return [...entries.values()]
  },
})

// The fixture ledgers' times are small numbers: "now" sits shortly after them
export const NOW = 1000

export const PLANS = '/repo/docs/superpowers/plans'
export const SDD = '/repo/.superpowers/sdd'
export const PHASE_7_DISK = {
  [`${PLANS}/2026-10-12-phase7-plan1-admin.md`]: { text: '# Phase 7 · Plan 1 — Admin Access Implementation Plan\n### Task 1: Roles\n### Task 2: Audit log' },
  [`${PLANS}/2026-10-13-phase7-plan2-tools.md`]: { text: '# Phase 7 · Plan 2 — User Tools Implementation Plan\n### Task 1: Blocking' },
  [`${PLANS}/2026-10-13-phase7-plan3-frontend.md`]: { text: PLAN },
  [`${PLANS}/2026-10-14-phase7-plan4-later.md`]: { text: '# Phase 7 · Plan 4 — Later Implementation Plan\n### Task 1: Next' },
  [`${PLANS}/2026-10-11-phase5-emails.md`]: { text: '# PoEvtini.bg Phase 5 — Alert Emails Implementation Plan\n### Task 1: Mailer' },
  [`${SDD}/2026-10-12-phase7-plan1-admin/progress.md`]: {
    text: '# SDD ledger — plan: docs/superpowers/plans/2026-10-12-phase7-plan1-admin.md\nTask 1: complete (a..b)\nTask 2: complete (b..c)',
    mtimeMs: 100,
  },
  [`${SDD}/2026-10-13-phase7-plan3-frontend/progress.md`]: {
    text: LEDGER.replace(/plan: .*/, 'plan: docs/superpowers/plans/2026-10-13-phase7-plan3-frontend.md'),
    mtimeMs: 300,
  },
}

