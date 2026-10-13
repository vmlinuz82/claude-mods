import type { On, RenderElement } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const SURFACES = ['desktop', 'terminal'] as const
const band = (hasSurvey = false) =>
  ({
    plugin: 'skill-usage',
    component: 'AbovePrompt',
    props: { hasSurvey, isWorking: false, maxRows: 20, bodyColumns: 80 } as never,
  }) as const
const pane = { plugin: 'skill-usage', component: 'Pane', requestId: 'skill-usage', props: { bodyColumns: 30 } as never } as const

// Stands in for the engine: four skills and two MCP servers, nothing beneath the plugin drawing
const engine = (on: On) => {
  on('session.start', async (_$, e) => e)
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.usage', async () => ({
    value: {
      context: {
        window: 200000,
        breakdown: {
          mcpTools: [
            { name: 'mcp__workbench-gitlab__get_mr', serverName: 'workbench-gitlab', tokens: 1, isLoaded: true },
            { name: 'mcp__workbench-gitlab__get_diff', serverName: 'workbench-gitlab', tokens: 1, isLoaded: true },
            { name: 'mcp__claude_ai_Gmail__send', serverName: 'claude.ai Gmail', tokens: 1, isLoaded: true },
          ],
          skills: {
            totalSkills: 6,
            includedSkills: 6,
            tokens: 6,
            skillFrontmatter: ['review', 'plugin-authoring', 'loop', 'init', 'simplify', 'dataviz'].map(name => ({
              name,
              source: 'plugin',
              tokens: 1,
            })),
          },
        },
      },
    } as never,
  }))
  on('command.run', async () => ({ text: 'ok' }))
  on('tool.call', async () => ({ result: 'ok' }))
  on('ui.render', { component: 'AbovePrompt' }, async () => ({ type: 'engine', ref: 0 }) as RenderElement)
}

const callSkill = ($: Engine, skill: string) => $.tool.call({ tool: 'Skill', skill })
const typeCommand = ($: Engine, command: string) => $.command.run({ command, args: '', origin: 'user' } as never)

// Claude calls plugin-authoring twice, the person types /review, and /help (a built-in, not a skill)
const use = async ($: Engine) => {
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await callSkill($, 'plugin-authoring')
  await callSkill($, 'plugin-authoring')
  await typeCommand($, 'review')
  await typeCommand($, 'help')
  for (const tool of ['mcp__workbench-gitlab__get_mr', 'mcp__workbench-gitlab__get_diff', 'mcp__claude_ai_Gmail__send', 'Bash']) {
    await $.tool.call({ tool, command: 'ls' } as never)
  }
}

const texts = async (ui: { findAll: (query: { type: 'Text' }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(one => one.text)

test('shows only used skills and MCP servers above the prompt, top five of each', async ($, on) => {
  engine(on)
  await use($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...band(), surface })
    // Claude's Skill calls and the typed /review both count; /help (not a skill) and unused skills stay out
    expect(await texts(ui)).toEqual(['plugin-authoring 2', 'review 1', 'workbench-gitlab 2', 'claude.ai Gmail 1'])
  }

  for (const skill of ['loop', 'init', 'simplify', 'dataviz']) {
    await callSkill($, skill)
  }

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...band(), surface })
    // Six used: most used first, then alphabetical, and `simplify` falls outside the top five
    expect(await texts(ui)).toEqual([
      'plugin-authoring 2',
      'dataviz 1',
      'init 1',
      'loop 1',
      'review 1',
      'workbench-gitlab 2',
      'claude.ai Gmail 1',
    ])
  }
})

test('the pane is a table of the skills and servers used, most used first', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

  const open = await Promise.all(SURFACES.map(surface => $.ui.mount({ ...pane, surface })))
  for (const ui of open) {
    expect(await texts(ui)).toEqual(['No skills or MCP servers used in this session yet.'])
  }

  await use($)

  // The open pane redraws as uses come in
  for (const ui of open) {
    // Read in pairs: name, then its count on the same row; the four unused skills stay out
    expect(await texts(ui)).toEqual([
      'Skill', 'Uses',
      'plugin-authoring', '2',
      'review', '1',
      'MCP server', 'Uses',
      'workbench-gitlab', '2',
      'claude.ai Gmail', '1',
    ])
  }
})

test('hides until something is used, keeps another mod band on top and steps aside for a survey', async ($, on) => {
  on('session.start', async (_$, e) => e)
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.usage', async () => ({
    value: { context: { window: 1, breakdown: { mcpTools: [], skills: { totalSkills: 1, includedSkills: 1, tokens: 1, skillFrontmatter: [{ name: 'review', source: 'plugin', tokens: 1 }] } } } } as never,
  }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return h(Text, {}, 'task band') as RenderElement
  })
  on('tool.call', async () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

  for (const surface of SURFACES) {
    const unused = await $.ui.mount({ ...band(), surface })
    expect(await texts(unused)).toEqual(['task band'])
  }

  await callSkill($, 'review')

  for (const surface of SURFACES) {
    const shared = await $.ui.mount({ ...band(), surface })
    // Only the group with usage shows: a Skills row, no MCP row
    expect(await texts(shared)).toEqual(['task band', 'review 1'])
    expect((await shared.findAll({ type: 'Button' })).map(one => one.key)).toEqual(['open-skills', 'close'])
    const survey = await $.ui.mount({ ...band(true), surface })
    expect(await texts(survey)).toEqual(['task band'])
  }
})

test('the Skills and MCP labels open the pane', async ($, on) => {
  engine(on)
  const opened: string[] = []
  on('ui.open', async (_$, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } } as never
  })
  await use($)

  for (const surface of SURFACES) {
    opened.length = 0
    const ui = await $.ui.mount({ ...band(), surface })
    await ui.press({ key: 'open-skills' })
    await ui.press({ key: 'open-servers' })
    expect(opened).toEqual(['skill-usage', 'skill-usage'])
  }
})

test('the close button hides the band until the next use', async ($, on) => {
  engine(on)
  await use($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...band(), surface })
    expect((await ui.find({ key: 'close' }))?.props.role).toBe('dismiss')
    await ui.press({ key: 'close' })
    const closed = await $.ui.mount({ ...band(), surface })
    expect(await texts(closed)).toEqual([])

    // A Bash call is no skill or MCP use, so the band stays closed; a skill call brings it back
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    expect(await texts(await $.ui.mount({ ...band(), surface }))).toEqual([])
    await callSkill($, 'review')
    const reopened = await texts(await $.ui.mount({ ...band(), surface }))
    expect(reopened.some(text => text.startsWith('review '))).toBe(true)
  }
})
