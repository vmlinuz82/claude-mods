import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Catalog, Counts } from '../types'

const PANE = 'skill-usage'
const PANE_TITLE = 'Skills & MCP usage'
const BAND_TOP = 5

const catalog = atom({ plugin: 'skill-usage', key: 'catalog' } as const, { skills: [], servers: [], toolServers: {} })
const counts = atom({ plugin: 'skill-usage', key: 'counts' } as const, { skills: {}, servers: {} })

type Row = { name: string; count: number }

// Every known name, used or not, most used first, then alphabetical
const toRows = (names: readonly string[], used: Readonly<Record<string, number>>): Row[] =>
  [...new Set([...names, ...Object.keys(used)])]
    .map(name => ({ name, count: used[name] ?? 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

const serverOf = (tool: string, known: Readonly<Record<string, string>>): string =>
  known[tool] ?? tool.split('__')[1] ?? tool

// MCP servers often connect after the session starts, so this runs again at every turn
const refresh = async ($: EngineInterface): Promise<void> => {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  const breakdown = context.breakdown
  if (!breakdown) {
    return
  }

  const toolServers = Object.fromEntries(breakdown.mcpTools.map(tool => [tool.name, tool.serverName]))
  const next: Catalog = {
    skills: (breakdown.skills?.skillFrontmatter ?? []).map(skill => skill.name),
    servers: [...new Set(Object.values(toolServers))],
    toolServers,
  }
  await update($, catalog, () => next)
}

const bump = (counted: Readonly<Record<string, number>>, name: string): Record<string, number> => ({
  ...counted,
  [name]: (counted[name] ?? 0) + 1,
})

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'skill-usage',
      description: 'Show every skill and MCP server in this session with how many times each was used',
    })
    await refresh($)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await refresh($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'skill-usage' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: PANE_TITLE })

    return { text: `${PANE_TITLE} pane opened.` }
  })

  // Counted before the call runs, so a failed count never re-runs or blocks the skill
  on('skill.prompt', async ($, e, next) => {
    await update($, counts, (now: Counts) => ({ ...now, skills: bump(now.skills, e.skill) }))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (!e.tool.startsWith('mcp__')) {
      return next(e)
    }

    const { toolServers } = await read($, catalog)
    const server = serverOf(e.tool, toolServers)
    await update($, counts, (now: Counts) => ({ ...now, servers: bump(now.servers, server) }))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const known = await read($, catalog)
    const used = await read($, counts)
    const usedOnly = (rows: readonly Row[]) => rows.filter(row => row.count > 0).slice(0, BAND_TOP)
    const skills = usedOnly(toRows(known.skills, used.skills))
    const servers = usedOnly(toRows(known.servers, used.servers))
    // Nothing used yet this session: no band at all
    if (skills.length === 0 && servers.length === 0) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const groups = [
      { key: 'skills', label: 'Skills', rows: skills },
      { key: 'servers', label: 'MCP', rows: servers },
    ].filter(group => group.rows.length > 0)
    // Each group with usage is one row of its most used `name count` items; the label opens the pane
    const mine = (
      <Box key="skill-usage" flexDirection="column">
        {groups.map(group => (
          <Box key={group.key} flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Button
              key={`open-${group.key}`}
              label={group.label}
              plain
              onPress={() => $.ui.open({ id: PANE, title: PANE_TITLE })}
            />
            {group.rows.map(row => (
              <Text key={row.name}>
                {row.name} {row.count}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    )

    // Another mod's band (the task list) stays on top; the engine's own placeholder is left out
    const below = await next(e)
    if (below.type === 'engine') {
      return mine
    }

    return (
      <Box flexDirection="column">
        {below}
        {mine}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const known = await read($, catalog)
    const used = await read($, counts)
    const sections = [
      { key: 'skills', title: 'Skill', rows: toRows(known.skills, used.skills).filter(row => row.count > 0) },
      { key: 'servers', title: 'MCP server', rows: toRows(known.servers, used.servers).filter(row => row.count > 0) },
    ].filter(section => section.rows.length > 0)

    if (sections.length === 0) {
      return <Text dimColor>No skills or MCP servers used in this session yet.</Text>
    }

    // One table per section with usage: the name on the left, the count pushed to the right edge,
    // so the counts line up in the desktop app's proportional font as well as in the terminal
    return (
      <Box flexDirection="column">
        {sections.map(section => (
          <Box key={section.key} flexDirection="column" marginBottom={1}>
            <Box key="head" flexDirection="row" justifyContent="space-between" columnGap={2}>
              <Text key="name" bold>
                {section.title}
              </Text>
              <Text key="count" bold>
                Uses
              </Text>
            </Box>
            {section.rows.map(row => (
              <Box key={row.name} flexDirection="row" justifyContent="space-between" columnGap={2}>
                <Box key="name" flexShrink={1}>
                  <Text wrap="truncate-end">{row.name}</Text>
                </Box>
                <Text key="count">{row.count}</Text>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
