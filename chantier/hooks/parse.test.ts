import { describe, expect, test } from 'claude-code/testing'

import {
  CHANGES,
  QUOTA,
  ancestors,
  applyState,
  detect,
  expand,
  frontmatter,
  ledgerMeta,
  inFlight,
  onHold,
  lastNote,
  ledgerState,
  mangle,
  namesId,
  samePlan,
  worktreePaths,
  manifestStatus,
  planTasks,
  prNumbers,
  resolveState,
  sentence,
  sddMatches,
  summary,
} from './register'

describe('avancement', () => {
  test('les tâches du plan ignorent les titres dans les blocs de code', async () => {
    const plan = '### Task 0 : a\n```\n### Task 9 : faux\n```\n### Task 7b : fiche\n## Résumé\n'
    expect(planTasks(plan)).toEqual(['0', '7b'])
  })

  test('le registre compte les tâches closes et garde le dernier pas', async () => {
    const { done, lastStep } = ledgerState('Task 0: complete (x)\nTask 1: dispatched\nTask 1: minor (deferred): y\n')
    expect([...done]).toEqual(['0'])
    expect(lastStep).toBe('Task 1: dispatched')
  })

  test('un plan à plusieurs PR : la section qui nomme l’élément borne ses tâches', async () => {
    const plan = '## Partie A — PR-7a (backend)\n### Task A1 `[USER]` : a\n### Task A2 : b\n## Partie B — PR-7b (frontend)\n### Task B1 : c\n### Task B2 : d\n### Task B3 : e\n## Questions\n'
    expect(planTasks(plan, 'PR-7b')).toEqual(['B1', 'B2', 'B3'])
    expect(planTasks(plan, 'PR-7a')).toEqual(['A1', 'A2'])
    // « PR-7 » ne nomme ni PR-7a ni PR-7b : tout le plan
    expect(planTasks(plan, 'PR-7')).toEqual(['A1', 'A2', 'B1', 'B2', 'B3'])
    expect(namesId('## Partie B — PR-7b (frontend)', 'PR-7b')).toBe(true)
    expect(namesId('## Partie B — PR-7b (frontend)', 'PR-7')).toBe(false)
    const { done, lastStep } = ledgerState('Task A12: complete\nTask B1: complete\nTask B2: complete (x)\nTask A9: re-revue\n', ['B1', 'B2', 'B3'])
    expect([...done].filter(t => t.startsWith('B'))).toEqual(['B1', 'B2'])
    expect(lastStep).toBe('Task B2: complete (x)')
  })

  test('registres des worktrees, même plan, en cours et dernière note', async () => {
    expect(worktreePaths('worktree /r/gflow\nHEAD 1\nbranch refs/heads/main\n\nworktree /r/gflow/.claude/worktrees/w\nHEAD 2\n')).toEqual([
      '/r/gflow',
      '/r/gflow/.claude/worktrees/w',
    ])
    expect(samePlan('/r/gflow/docs/superpowers/plans/x.md', 'docs/superpowers/plans/x.md')).toBe(true)
    expect(samePlan('/r/gflow/docs/superpowers/plans/x.md', 'docs/superpowers/plans/y.md')).toBe(false)
    const rows = [
      { id: 'PR-7', title: 'Backend', objective: '', status: 'merged' as const, progress: 1 },
      { id: 'PR-7b', title: 'Tiroir', objective: '', status: 'in_progress' as const, progress: 0.2, tasksDone: 2, tasksTotal: 9, nextTask: 'B3' },
      { id: 'PR-8', title: 'Supervision', objective: '', status: 'open' as const, progress: 0.9, github: 701 },
    ]
    expect(inFlight(rows)).toEqual(['PR-7b Tiroir — en cours, 2/9 tâches, prochaine B3', 'PR-8 Supervision — PR ouverte #701'])
    expect(lastNote('intro\n**PR-7a** mergée.\n\n**Session 49 (22/10)** : `B3` lancée, voir [[chantier-x]].\n')).toBe('Session 49 (22/10) : B3 lancée, voir chantier-x.')
    expect(lastNote('rien de daté')).toBeUndefined()
  })

  test('les numéros de PR et les plages sont dépliés', async () => {
    expect(prNumbers('#596→#599 puis #613, et #613 encore')).toEqual([596, 597, 598, 599, 613])
  })

  test('frontmatter, résumé et dossier mémoire', async () => {
    const fm = frontmatter('---\nname: chantier-x\ndescription: "✅ CLOS"\n---\ncorps')
    expect(fm.description).toBe('✅ CLOS')
    expect(summary('## Summary\n\n- **Un** coffre chiffré\n')).toBe('Un coffre chiffré')
    expect(mangle('/Users/a/Projets/gflow')).toBe('-Users-a-Projets-gflow')
  })

  test('le chantier le plus cité gagne', async () => {
    const known = [
      { slug: 'agents-ia', title: 'Agents IA', keys: ['chantier-agents-ia', 'chantier agents ia', 'agents-ia'] },
      { slug: 'post-its', title: 'Post-its', keys: ['chantier-post-its', 'chantier post-its', 'post-its'] },
    ]
    expect(detect('Reprise gflow — chantier Agents IA, incrément 2', known)).toBe('agents-ia')
    expect(detect('rien à voir', known)).toBeUndefined()
  })

  test('un élément du manifeste retrouve son dossier SDD', async () => {
    expect(sddMatches('2026-10-13-agents-ia-pr2b-onglet-connexions', 'agents-ia', 'PR-2b')).toBe(true)
    expect(sddMatches('2026-10-13-agents-ia-pr2b', 'agents-ia', 'PR-2b')).toBe(true)
    expect(sddMatches('2026-10-13-agents-ia-pr2b-onglet-connexions', 'agents-ia', 'PR-2')).toBe(false)
    expect(sddMatches('2026-10-13-post-its-pr2b', 'agents-ia', 'PR-2b')).toBe(false)
    const meta = ledgerMeta('# SDD ledger — plan: /a/plans/x.md\n\nWorktree : w — branche feat/agents-ia-onglet-connexions depuis main d75df0f1.\n')
    expect(meta).toEqual({ plan: '/a/plans/x.md', branch: 'feat/agents-ia-onglet-connexions' })
  })

  test('les appels qui font avancer un chantier sont reconnus', async () => {
    expect(CHANGES.test('{"command":"gh pr merge 649 --squash"}')).toBe(true)
    expect(CHANGES.test('{"file_path":"/r/.superpowers/sdd/x/progress.md"}')).toBe(true)
    expect(CHANGES.test('{"command":"gh pr view 649"}')).toBe(false)
  })
})

describe('GitHub indisponible', () => {
  const row = (id: string) => ({ id, title: id, objective: '', status: 'planned' as const, progress: 0 })

  test('le statut « merged » du manifeste suffit, sans gh', async () => {
    expect(manifestStatus('merged')).toBe('merged')
    expect(manifestStatus('todo')).toBeUndefined()
    const r = applyState(row('PR-1'), 'merged', 664, undefined)
    expect([r.status, r.progress, r.github]).toEqual(['merged', 1, 664])
    // gh ne contredit pas un « merged » déclaré
    expect(applyState(row('PR-1'), 'merged', 664, { number: 664, state: 'OPEN' }).status).toBe('merged')
  })

  test('audit-plugins : 15/16 mergées avec gh en erreur partout', async () => {
    const specs = [...Array.from({ length: 15 }, (_, i) => ({ id: `PR-${i}`, status: 'merged', github: 664 + i })), { id: 'PR-11b', status: 'todo', github: undefined }]
    const rows = specs.map(s => applyState(row(s.id), manifestStatus(s.status), s.github, undefined))
    expect(rows.filter(r => r.status === 'merged').length).toBe(15)
    expect(rows[15]?.status).toBe('planned')
  })

  test('un échec gh garde le dernier état connu et ne rétrograde jamais', async () => {
    const open = { number: 685, state: 'OPEN' }
    const merged = { number: 685, state: 'MERGED' }
    expect(resolveState(undefined, open)).toEqual(open)
    expect(resolveState(undefined, undefined)).toBeUndefined()
    expect(resolveState(merged, open)).toEqual(merged)
    expect(resolveState({ number: 685, state: 'CLOSED' }, merged)).toEqual(merged)
    expect(applyState(row('PR-11b'), undefined, 685, resolveState(undefined, open)).status).toBe('open')
  })

  test('le quota épuisé est reconnu dans la sortie de gh', async () => {
    expect(QUOTA.test('GraphQL: API rate limit already exceeded for user ID 1.')).toBe(true)
    expect(QUOTA.test('You have exceeded a secondary rate limit')).toBe(true)
    expect(QUOTA.test('no pull requests found for branch "x"')).toBe(false)
  })

  test('un worktree supprimé remonte vers ses parents', async () => {
    expect(ancestors('/r/gflow/.claude/worktrees/x')).toEqual(['/r/gflow/.claude/worktrees', '/r/gflow/.claude', '/r/gflow', '/r'])
    expect(ancestors('/r')).toEqual([])
  })
})

describe('pause et PR découpées', () => {
  const row = (id: string, status: 'planned' | 'in_progress' = 'planned') => ({ id, title: id, objective: '', status, progress: 0 })

  test('« paused » déclaré l’emporte sur le registre SDD et sur une PR ouverte, pas sur une PR mergée', async () => {
    expect(manifestStatus('paused')).toBe('paused')
    expect(manifestStatus('in_progress')).toBe('in_progress')
    expect(manifestStatus('pending')).toBeUndefined()
    expect(applyState(row('PR-9', 'in_progress'), 'paused', undefined, undefined).status).toBe('paused')
    expect(applyState(row('PR-9', 'in_progress'), 'paused', undefined, { number: 712, state: 'OPEN' }).status).toBe('paused')
    expect(applyState(row('PR-9', 'in_progress'), 'paused', undefined, { number: 712, state: 'MERGED' }).status).toBe('merged')
    // « in_progress » déclaré sans plan ni registre : en cours, pas « à venir »
    expect(applyState(row('PR-8e2'), 'in_progress', undefined, undefined).status).toBe('in_progress')
  })

  test('une PR en pause n’est jamais « en cours » et se dit « en pause »', async () => {
    const rows = [
      { ...row('PR-9', 'in_progress'), title: 'Confier', status: 'paused' as const, tasksDone: 2, tasksTotal: 12, nextTask: 'A3' },
      { ...row('PR-8e2', 'in_progress'), title: 'Langue' },
    ]
    expect(inFlight(rows)).toEqual(['PR-8e2 Langue — en cours'])
    expect(onHold(rows)).toEqual(['PR-9 Confier — 2/12 tâches'])
    expect(sentence({ title: 'Agents IA', progress: 0.5, merged: 1, total: 2, inFlight: inFlight(rows), onHold: onHold(rows) })).toBe(
      'Agents IA : 50 % — 1/2 PR mergées. En cours : PR-8e2 Langue — en cours. En pause : PR-9 Confier — 2/12 tâches.',
    )
  })

  test('les parts remplacent leur parent et en héritent titre, objectif, plan et statut final', async () => {
    const specs = expand([
      { id: 'PR-7', title: 'Backend', objective: 'o7', github: 700 },
      {
        id: 'PR-8',
        title: 'Supervision',
        objective: 'o8',
        plan: 'docs/p8.md',
        status: 'merged',
        parts: [{ id: 'PR-8a', github: 705, status: 'merged' }, { id: 'PR-8b' }],
      },
      {
        id: 'PR-8e',
        title: 'Droits',
        objective: 'o8e',
        status: 'in_progress',
        parts: [{ id: 'PR-8e1', title: 'Fuite', status: 'merged', github: 711 }, { id: 'PR-8e2', status: 'in_progress' }, { id: 'PR-8e3', status: 'pending' }],
      },
      { id: 'PR-9', title: 'Confier', objective: '', status: 'paused' },
    ])
    expect(specs.map(s => s.id)).toEqual(['PR-7', 'PR-8a', 'PR-8b', 'PR-8e1', 'PR-8e2', 'PR-8e3', 'PR-9'])
    expect(specs.map(s => s.status)).toEqual([undefined, 'merged', 'merged', 'merged', 'in_progress', 'pending', 'paused'])
    expect(specs[2]).toMatchObject({ title: 'Supervision', objective: 'o8', parentPlan: 'docs/p8.md' })
    expect(specs[2]?.plan).toBeUndefined()
    expect(specs[3]).toMatchObject({ title: 'Fuite', github: 711 })
    // un « in_progress » du parent ne passe pas à ses parts
    expect(expand([{ id: 'P', title: 't', objective: '', status: 'in_progress', parts: [{ id: 'P1' }] }])[0]?.status).toBeUndefined()
    expect(specs.some(s => 'parts' in s)).toBe(false)
  })
})

