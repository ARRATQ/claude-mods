import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

// /chantier joué avec un dépôt simulé : le registre SDD de la PR en cours vit dans
// un worktree, et son plan sert deux PR (parties A et B).

const ROOT = '/r/gflow'
const TREE = `${ROOT}/.claude/worktrees/w`
const PLAN = `${ROOT}/docs/superpowers/plans/2026-10-22-x-pr7.md`
const LEDGER = `${TREE}/.superpowers/sdd/2026-10-22-x-pr7-tiroir/progress.md`
const MEMORY = `/h/.claude/projects/-r-gflow/memory`

const manifest = JSON.stringify({
  title: 'Agents IA',
  objective: 'Des agents.',
  prs: [
    { id: 'PR-7', title: 'Backend', github: 700, status: 'merged' },
    { id: 'PR-7b', title: 'Tiroir', plan: PLAN },
    { id: 'PR-8', title: 'Supervision' },
  ],
})
const plan = '# X\n## Partie A — PR-7a\n### Task A1 : a\n## Partie B — PR-7b\n### Task B1 : b\n### Task B2 : c\n### Task B3 : d\n'
const ledger = `# SDD ledger — plan: ${PLAN}\nTask A1: complete\nTask B1: complete\nTask B2: complete (2916b597)\n`

const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })
const run = (exitCode: number, stdout: string) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

function fakeRepo(on: On) {
  const m = new Map<string, unknown>()
  on('store.get', async ($, e) => ({ value: m.get(e.key) }))
  on('store.set', async ($, e) => {
    m.set(e.key, e.value)
    return { value: undefined }
  })
  on('env.get', async () => ({ value: '/h' }))
  on('session.cwd', async () => ({ value: TREE }))
  on('fs.exists', async () => ({ value: true }))
  const dirs: Record<string, ReturnType<typeof entry>[]> = {
    [`${ROOT}/.superpowers/chantiers`]: [entry('x.json', 'file')],
    [`${TREE}/.superpowers/sdd`]: [entry('2026-10-22-x-pr7-tiroir', 'dir')],
    [MEMORY]: [entry('chantier-x.md', 'file')],
  }
  on('fs.list', async ($, e) => ({ value: dirs[e.path] ?? [] }))
  const files: Record<string, string> = {
    [`${ROOT}/.superpowers/chantiers/x.json`]: manifest,
    [PLAN]: plan,
    [LEDGER]: ledger,
    [`${MEMORY}/chantier-x.md`]: '---\nname: chantier-x\n---\n**PR-7a** mergée.\n**Session 49 (22/10)** : B3 lancée.\n',
  }
  on('fs.read', async ($, e) => {
    if (e.path in files) return { value: files[e.path] as string }
    throw new Error(`absent : ${e.path}`)
  })
  on('process.run', async ($, e) => {
    if (e.argv[1] === 'rev-parse') return { value: run(0, `${ROOT}/.git\n`) }
    if (e.argv[1] === 'worktree') return { value: run(0, `worktree ${ROOT}\nHEAD 1\n\nworktree ${TREE}\nHEAD 2\n`) }
    return { value: run(1, '') }
  })
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
}

describe('PR en cours dans un worktree', () => {
  test('/chantier nomme la PR en cours, ses tâches et la prochaine', async ($, on) => {
    fakeRepo(on)
    const out = await $.command.run({ command: 'chantier', args: 'x', origin: 'user' } as never)
    expect(out.text).toBe('Agents IA : 54 % — 1/3 PR mergées. En cours : PR-7b Tiroir — en cours, 2/3 tâches, prochaine B3.')
    const ui = await $.ui.mount({
      plugin: 'chantier',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'chantier',
      props: { title: 'Chantier', isFocused: false, bodyColumns: 120 } as never,
    })
    expect(await ui.find({ type: 'Text', text: /▶ En cours : PR-7b Tiroir/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Dernière note : Session 49 \(22\/10\) : B3 lancée\./ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Prochaine : Task B3/ })).toBeDefined()
    await ui.unmount()
  })
})

// Manifeste du chantier agents-ia du 25/10 en réduit : entrée ancienne sans statut
// (mergée d'après gh), PR découpées en parts, PR en pause dont le registre SDD
// existe encore, dossier SDD d'une part et du parent.
const P9 = `${ROOT}/docs/superpowers/plans/2026-10-25-y-pr9.md`
const L9 = `${TREE}/.superpowers/sdd/2026-10-25-y-pr9-confier/progress.md`
const L8E1 = `${TREE}/.superpowers/sdd/2026-10-25-y-pr8e1-droits/progress.md`
const L8E = `${TREE}/.superpowers/sdd/2026-10-25-y-pr8e-parent/progress.md`

const splitManifest = JSON.stringify({
  title: 'Agents IA',
  objective: 'Des agents.',
  prs: [
    { id: 'PR-1a', title: 'Socle', github: 639 },
    {
      id: 'PR-8',
      title: 'Supervision',
      status: 'merged',
      parts: [{ id: 'PR-8a', github: 705, status: 'merged' }, { id: 'PR-8b', github: 706 }],
    },
    {
      id: 'PR-8e',
      status: 'in_progress',
      parts: [
        { id: 'PR-8e1', title: 'Fuite', status: 'merged', github: 711 },
        { id: 'PR-8e2', title: 'Langue', status: 'in_progress' },
        { id: 'PR-8e3', title: 'Frontend', status: 'pending' },
      ],
    },
    { id: 'PR-9', title: 'Confier', status: 'paused' },
    { id: 'PR-10', title: 'Rejeu' },
  ],
})

function fakeSplitRepo(on: On, gh: string[]) {
  const m = new Map<string, unknown>()
  on('store.get', async ($, e) => ({ value: m.get(e.key) }))
  on('store.set', async ($, e) => {
    m.set(e.key, e.value)
    return { value: undefined }
  })
  on('env.get', async () => ({ value: '/h' }))
  on('session.cwd', async () => ({ value: TREE }))
  on('fs.exists', async () => ({ value: true }))
  const dirs: Record<string, ReturnType<typeof entry>[]> = {
    [`${ROOT}/.superpowers/chantiers`]: [entry('y.json', 'file')],
    [`${TREE}/.superpowers/sdd`]: [
      entry('2026-10-25-y-pr9-confier', 'dir'),
      entry('2026-10-25-y-pr8e1-droits', 'dir'),
      entry('2026-10-25-y-pr8e-parent', 'dir'),
    ],
  }
  on('fs.list', async ($, e) => ({ value: dirs[e.path] ?? [] }))
  const files: Record<string, string> = {
    [`${ROOT}/.superpowers/chantiers/y.json`]: splitManifest,
    [P9]: '# Confier\n### Task A1 : a\n### Task A2 : b\n### Task A3 : c\n',
    [L9]: `# SDD ledger — plan: ${P9}\n\nWorktree : w — branche feat/y-pr9 depuis main.\nTask A1: complete\nTask A2: dispatched\n`,
    [L8E1]: `# SDD ledger — plan: ${ROOT}/docs/superpowers/plans/y-pr8e1.md\nTask A1: complete\n`,
    [L8E]: `# SDD ledger — plan: ${ROOT}/docs/superpowers/plans/y-pr8e.md\nTask A1: dispatched\n`,
  }
  on('fs.read', async ($, e) => {
    if (e.path in files) return { value: files[e.path] as string }
    throw new Error(`absent : ${e.path}`)
  })
  on('process.run', async ($, e) => {
    if (e.argv[1] === 'rev-parse') return { value: run(0, `${ROOT}/.git\n`) }
    if (e.argv[1] === 'worktree') return { value: run(0, `worktree ${ROOT}\nHEAD 1\n\nworktree ${TREE}\nHEAD 2\n`) }
    if (e.argv[0] === 'gh') {
      gh.push(e.argv.slice(1, 4).join(' '))
      // PR-1a : mergée d'après GitHub ; PR-9 : une PR ouverte sur sa branche
      if (e.argv[2] === 'view') return { value: run(0, JSON.stringify({ number: Number(e.argv[3]), state: 'MERGED' })) }
      if (e.argv[2] === 'list') return { value: run(0, JSON.stringify([{ number: 712, state: 'OPEN' }])) }
    }
    return { value: run(1, '') }
  })
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
}

describe('PR découpées et PR en pause', () => {
  test('/chantier compte les parts, pas leur parent, et ne dit jamais « en cours » une PR en pause', async ($, on) => {
    const gh: string[] = []
    fakeSplitRepo(on, gh)
    const out = await $.command.run({ command: 'chantier', args: 'y', origin: 'user' } as never)
    // 8 éléments comptés (PR-1a, 8a, 8b, 8e1, 8e2, 8e3, 9, 10) ; mergées : 1a via gh, 8a et 8e1
    // déclarées, 8b par le « merged » de son parent
    expect(out.text).toBe('Agents IA : 54 % — 4/8 PR mergées. En cours : PR-8e2 Langue — en cours. En pause : PR-9 Confier — 1/3 tâches.')
    // gh n'est demandé que pour les entrées sans « merged » déclaré ni hérité
    expect(gh.sort()).toEqual(['pr list --head', 'pr view 639'])
    const ui = await $.ui.mount({
      plugin: 'chantier',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'chantier',
      props: { title: 'Chantier', isFocused: false, bodyColumns: 120 } as never,
    })
    expect(await ui.find({ type: 'Text', text: /‖ En pause : PR-9 Confier/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▶ En cours : PR-8e2 Langue/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▶ En cours : PR-9/ })).toBeUndefined()
    await ui.unmount()
  })
})
