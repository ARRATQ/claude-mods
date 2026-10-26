import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

// /chantier joué par le moteur avec un dépôt et un gh simulés sous le plugin :
// la session est restée dans un worktree supprimé et gh répond « quota épuisé ».

const ROOT = '/r/gflow'
const DEAD = `${ROOT}/.claude/worktrees/plugins-pr11`
const QUOTA_ERR = 'GraphQL: API rate limit already exceeded for user ID 1.'

const manifest = (last: Record<string, unknown>) =>
  JSON.stringify({
    title: 'Audit des plugins et du Lua interne',
    objective: 'Auditer les plugins core.*',
    prs: [
      ...Array.from({ length: 15 }, (_, i) => ({ id: `PR-${i + 1}`, title: `PR ${i + 1}`, github: 664 + i, status: 'merged' })),
      { id: 'PR-11b', title: 'Suite', status: 'todo', ...last },
    ],
  })

const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })
const run = (exitCode: number, stdout: string, stderr = '') => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

// $.store du plugin, lisible par le test (le $ du test n'a pas de store).
function memStore(on: On, entries: Record<string, unknown> = {}): Map<string, unknown> {
  const m = new Map(Object.entries(entries))
  on('store.get', async ($, e) => ({ value: m.get(e.key) }))
  on('store.set', async ($, e) => {
    m.set(e.key, e.value)
    return { value: undefined }
  })
  return m
}

function fakeRepo(on: On, text: string, ghCalls: string[][]) {
  mock.env(on, { HOME: '/h' })
  on('session.cwd', async () => ({ value: DEAD }))
  on('fs.exists', async ($, e) => ({ value: e.path !== DEAD }))
  on('fs.list', async ($, e) => ({ value: e.path === `${ROOT}/.superpowers/chantiers` ? [entry('audit-plugins.json', 'file')] : [] }))
  on('fs.read', async ($, e) => {
    if (e.path === `${ROOT}/.superpowers/chantiers/audit-plugins.json`) return { value: text }
    throw new Error(`absent : ${e.path}`)
  })
  on('process.run', async ($, e) => {
    if (e.argv[0] === 'git')
      return { value: e.init?.cwd === `${ROOT}/.claude/worktrees` ? run(0, `${ROOT}/.git\n`) : run(128, '', 'not a git repository') }
    ghCalls.push([...e.argv])
    return { value: run(1, '', QUOTA_ERR) }
  })
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
}

describe('GitHub en panne', () => {
  test('15/16 depuis le manifeste, sans un seul appel gh', async ($, on) => {
    const calls: string[][] = []
    memStore(on)
    fakeRepo(on, manifest({}), calls)
    const out = await $.command.run({ command: 'chantier', args: 'audit-plugins', origin: 'user' } as never)
    expect(out.text).toBe('Audit des plugins et du Lua interne : 94 % — 15/16 PR mergées.')
    expect(calls).toEqual([])
  })

  test('une PR ouverte connue reste ouverte, et le quota met gh en pause', async ($, on) => {
    const calls: string[][] = []
    const store = memStore(on, { [`pr:${ROOT}:685`]: { number: 685, state: 'OPEN' } })
    fakeRepo(on, manifest({ github: 685 }), calls)
    const first = await $.command.run({ command: 'chantier', args: 'audit-plugins', origin: 'user' } as never)
    expect(first.text).toBe('Audit des plugins et du Lua interne : 94 % — 15/16 PR mergées. En cours : PR-11b Suite — PR ouverte #685.')
    expect(calls.length).toBe(1)
    expect(Number(store.get('gh-pause-until'))).toBeGreaterThan(0)
    expect(store.get(`pr:${ROOT}:685`)).toEqual({ number: 685, state: 'OPEN' })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'chantier',
        surface,
        component: 'Pane',
        requestId: 'chantier',
        props: { title: 'Chantier', isFocused: false, bodyColumns: 120 } as never,
      })
      expect(await ui.find({ type: 'Text', text: /PR ouverte #685/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /GitHub en pause \(quota\)/ })).toBeDefined()
      await ui.unmount()
    }
    // En pause : la relance ne rappelle pas gh et garde l'état connu.
    await $.command.run({ command: 'chantier', args: 'audit-plugins', origin: 'user' } as never)
    expect(calls.length).toBe(1)
  })
})
