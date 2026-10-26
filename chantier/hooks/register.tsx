import type { Register } from 'claude-code'

import type { PrRow, PrStatus, Report } from '../types'

// Panneau /chantier : objectif, avancement exact et PR du chantier de la
// session. Sources, par ordre de préférence : .superpowers/chantiers/<slug>.json
// (manifeste rédigé) puis la mémoire du projet (chantier-<slug>.md : description
// = objectif, #numéros = PR) ; les registres SDD (.superpowers/sdd/*/progress.md)
// donnent l'avancement tâche par tâche. Le chantier de la session est détecté
// dans les prompts et les appels d'outils (slug, titre, branche, dossier SDD).

const PANE = 'chantier'
const REPORT = { plugin: 'chantier', key: 'report' } as const
const CURRENT = { plugin: 'chantier', key: 'current' } as const
const BUSY = { plugin: 'chantier', key: 'busy' } as const
const ROOT = { plugin: 'chantier', key: 'root' } as const
const MAX_GH = 40

type PrSpec = {
  id: string
  title: string
  objective: string
  github?: number
  plan?: string
  ledger?: string
  branch?: string
  // « merged » posé à la main fait foi : la PR n'est plus demandée à gh ;
  // « paused » l'emporte sur le registre SDD et sur une PR ouverte.
  status?: string
  merge_commit?: string
  // PR découpée : chaque part compte comme une PR, le parent ne compte plus.
  parts?: (Partial<PrSpec> & { id: string })[]
  // Plan du parent, pris par une part qui n'en a pas et dont aucun dossier SDD ne donne un.
  parentPlan?: string
}
// Dernier état GitHub connu d'une PR, gardé dans $.store entre les sessions.
export type GhPr = { number: number; state: string; title?: string; summary?: string }
type Manifest = { title: string; objective: string; prs: PrSpec[] }
// Entrée de $.fs.list : un dossier est 'dir', un lien symbolique 'other'.
type Entry = { name: string; kind: 'file' | 'dir' | 'other' }
type Known = { slug: string; title: string; keys: string[]; manifest?: string; memory?: string }

// ---- fonctions pures (testées) ----

export const mangle = (path: string) => path.replace(/[^A-Za-z0-9]/g, '-')

// Un plan peut couvrir plusieurs PR (« ## Partie B — PR-7b … ») : la section qui
// nomme l'élément (PR-7b, pas PR-7a ni PR-7) borne ses tâches.
export function namesId(heading: string, id: string): boolean {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^0-9A-Za-z])${esc}(?![0-9A-Za-z])`, 'i').test(heading)
}

// Ids des tâches du plan, dans l'ordre : « ### Task 7b : … », « ### Tâche 3 : … » et « ### Task B1 `[USER]` : … »
// ⇒ « 7b », « B1 ». Avec un id
// d'élément, seulement les tâches des sections « ## » qui le nomment, s'il y en a.
export function planTasks(plan: string, id?: string): string[] {
  const all: string[] = []
  const mine: string[] = []
  let inFence = false
  let inMine = false
  for (const line of plan.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence
    if (inFence) continue
    if (/^##\s/.test(line)) inMine = !!id && namesId(line, id)
    const m = /^###\s+(?:Task|Tâche)\s+([0-9A-Za-z]+)(?:\s+`[^`]*`)*\s*:/.exec(line)
    const t = m ? m[1] : undefined
    if (!t) continue
    if (!all.includes(t)) all.push(t)
    if (inMine && !mine.includes(t)) mine.push(t)
  }
  return mine.length ? mine : all
}

// Tâches closes du registre (« Task 3: complete … ») et dernière étape notée,
// parmi les tâches données (un registre peut servir plusieurs PR).
export function ledgerState(ledger: string, ids?: string[]): { done: Set<string>; lastStep?: string } {
  const done = new Set<string>()
  let lastStep: string | undefined
  for (const raw of ledger.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = /^Task\s+([0-9A-Za-z]+):\s+complete\b/.exec(line)
    if (m?.[1]) done.add(m[1])
    const step = /^Task\s+([0-9A-Za-z]+):/.exec(line)?.[1]
    if (step && (!ids || ids.includes(step)) && !/minor \(deferred/.test(line)) lastStep = line
  }
  return { done, lastStep }
}

// #numéros de PR cités ; « #596→#614 » est déplié (au plus 40 numéros).
export function prNumbers(text: string): number[] {
  const out = new Set<number>()
  for (const m of text.matchAll(/#(\d{2,5})\s*(?:→|->|\.\.)\s*#?(\d{2,5})/g)) {
    const a = Number(m[1])
    const b = Number(m[2])
    if (b > a && b - a <= 40) for (let n = a; n <= b; n++) out.add(n)
  }
  for (const m of text.matchAll(/#(\d{2,5})\b/g)) out.add(Number(m[1]))
  return [...out].sort((x, y) => x - y)
}

// Frontmatter minimal d'un fichier mémoire.
export function frontmatter(md: string): { name?: string; description?: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(md)
  if (!m) return { body: md }
  const head = m[1] ?? ''
  const pick = (k: string) => {
    const v = new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(head)?.[1]?.trim()
    return v?.replace(/^"(.*)"$/, '$1')
  }
  return { name: pick('name'), description: pick('description'), body: m[2] ?? '' }
}

// Chantier le plus cité dans un texte (prompt ou appel d'outil), ou undefined.
export function detect(text: string, known: Known[]): string | undefined {
  const hay = text.toLowerCase()
  let best: { slug: string; score: number } | undefined
  for (const k of known) {
    const score = k.keys.reduce((s, key) => s + (key && hay.includes(key) ? key.length : 0), 0)
    if (score > 0 && (!best || score > best.score)) best = { slug: k.slug, score }
  }
  return best?.slug
}

// Dossier SDD d'un élément du manifeste : « 2026-10-13-agents-ia-pr2b-onglet » pour
// PR-2b du chantier agents-ia ; « pr2 » ne prend pas le dossier de « pr2b ».
export function sddMatches(dir: string, slug: string, id: string): boolean {
  const tag = id.toLowerCase().replace(/[^a-z0-9]/g, '')
  return tag.length > 0 && dir.includes(`-${slug}-${tag}`) && new RegExp(`-${tag}(?:-|$)`).test(dir)
}

// En-tête d'un registre SDD : plan suivi et branche de travail.
export function ledgerMeta(ledger: string): { plan?: string; branch?: string } {
  const head = ledger.split('\n').slice(0, 8).join('\n')
  return {
    plan: /plan:\s*(\S+)/.exec(head)?.[1],
    branch: /\bbranche?\s+((?:feat|fix|chore|docs|refactor|test)\/[\w./-]+)/.exec(head)?.[1],
  }
}

// Même plan, écrit en absolu ou relatif à la racine : on compare la fin du chemin.
export const samePlan = (a: string, b: string) => a.replace(/^.*?docs\//, 'docs/') === b.replace(/^.*?docs\//, 'docs/')

// Dossiers des worktrees d'après « git worktree list --porcelain ».
export function worktreePaths(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .map(l => /^worktree\s+(.+)$/.exec(l)?.[1]?.trim())
    .filter((p): p is string => !!p)
}

// Dernière entrée datée d'une fiche mémoire (« **Session 49 (22/10…** »), sans
// le gras ni les liens : ce que la session précédente a noté en dernier.
export function lastNote(body: string, max = 320): string | undefined {
  const lines = body.split('\n').map(l => l.trim()).filter(l => l.startsWith('**'))
  const last = lines[lines.length - 1]
  if (!last) return undefined
  const line = last.replace(/\*\*|`/g, '').replace(/\[\[([^\]]+)\]\]/g, '$1').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// Résumé de ce qui est en cours : « PR-7b Titre — 2/9 tâches, prochaine B3 ».
export function inFlight(prs: PrRow[]): string[] {
  return prs
    .filter(pr => pr.status === 'in_progress' || pr.status === 'open')
    .map(pr => {
      const what = pr.status === 'open' ? `PR ouverte${pr.github ? ` #${pr.github}` : ''}` : 'en cours'
      const tasks = pr.tasksTotal ? `, ${pr.tasksDone}/${pr.tasksTotal} tâches` : ''
      const next = pr.status === 'in_progress' && pr.nextTask ? `, prochaine ${pr.nextTask}` : ''
      return `${pr.id} ${pr.title} — ${what}${tasks}${next}`
    })
}

// Ce qui est en pause : « PR-9 Confier à un agent — 2/12 tâches ».
export function onHold(prs: PrRow[]): string[] {
  return prs
    .filter(pr => pr.status === 'paused')
    .map(pr => `${pr.id} ${pr.title}${pr.tasksTotal ? ` — ${pr.tasksDone}/${pr.tasksTotal} tâches` : ''}`)
}

// Un appel d'outil qui change l'état d'un chantier : PR créée ou mergée, push,
// registre SDD ou manifeste écrit.
export const CHANGES = /\bgh\s+pr\s+(?:merge|create|ready|close|reopen)\b|\bgit\s+push\b|\.superpowers\/(?:sdd|chantiers)\//

// Première phrase utile du corps d'une PR (ni titre, ni liste vide).
export function summary(body: string, max = 220): string {
  for (const raw of body.split('\n')) {
    const line = raw.replace(/^[-*>\s]+/, '').replace(/[*_`]/g, '').trim()
    if (!line || line.startsWith('#') || /^(summary|résumé)\b/i.test(line)) continue
    return line.length > max ? `${line.slice(0, max - 1)}…` : line
  }
  return ''
}

// Statut écrit dans le manifeste ; « todo », « pending » et l'inconnu ne disent rien.
export function manifestStatus(s?: string): PrStatus | undefined {
  return s === 'merged' || s === 'open' || s === 'closed' || s === 'in_progress' || s === 'paused' ? s : undefined
}

// Éléments comptés du manifeste : une PR découpée (« parts ») cède la place à ses
// parts. Une part reprend du parent le titre et l'objectif qu'elle n'a pas, son
// plan en dernier recours, et un « merged » ou « paused » qui vaut pour toutes.
export function expand(prs: PrSpec[]): PrSpec[] {
  return prs.flatMap(spec => {
    if (!spec.parts?.length) return [spec]
    const { parts, ...parent } = spec
    const inherited = parent.status === 'merged' || parent.status === 'paused' ? parent.status : undefined
    return parts.map(p => ({
      ...p,
      title: p.title ?? parent.title,
      objective: p.objective ?? parent.objective,
      status: p.status ?? inherited,
      parentPlan: parent.plan,
    }))
  })
}

// État retenu d'une PR : un échec gh (fresh absent) garde le dernier connu, et
// une PR mergée le reste — un appel raté ne rétrograde jamais rien.
export function resolveState(fresh: GhPr | undefined, known: GhPr | undefined): GhPr | undefined {
  if (known?.state === 'MERGED') return known
  return fresh ?? known
}

// Statut d'une ligne du manifeste : « merged » déclaré l'emporte ; « paused »
// aussi, sauf contre une PR mergée sur GitHub ; sinon l'état GitHub (frais ou
// dernier connu) ; sinon le statut déclaré ; sinon la ligne telle que le plan et
// le registre SDD l'ont faite (en cours, à venir).
export function applyState(row: PrRow, declared: PrStatus | undefined, github: number | undefined, one: GhPr | undefined): PrRow {
  const out = { ...row }
  if (declared !== 'merged' && one && (declared !== 'paused' || one.state === 'MERGED')) {
    out.github = one.number
    out.status = ghState(one.state)
  } else if (declared) {
    out.status = declared
    if (github) out.github = github
  }
  if (out.status === 'merged') out.progress = 1
  return out
}

// Sortie de gh qui dit que le quota GitHub est épuisé.
export const QUOTA = /rate limit|abuse detection/i

// Dossiers parents d'un chemin, du plus proche au plus lointain (sans « / »).
export function ancestors(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  const out: string[] = []
  for (let i = parts.length - 1; i > 0; i--) out.push(`/${parts.slice(0, i).join('/')}`)
  return out
}

// ---- lecture du dépôt ----

// Racine du dépôt. Un worktree supprimé laisse la session dans un dossier mort :
// on reprend alors la dernière racine connue, à défaut le plus proche parent vivant.
async function repoRoot($: any): Promise<string> {
  const cwd: string = await $.session.cwd()
  const { value: last } = await $.state.get(ROOT)
  let base = cwd
  if (!(await $.fs.exists(cwd).catch(() => false))) {
    if (last) return last
    for (const dir of ancestors(cwd)) {
      if (await $.fs.exists(dir).catch(() => false)) {
        base = dir
        break
      }
    }
  }
  const out = await $.process
    .run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: base })
    .catch(() => undefined)
  const dir = out && out.exitCode === 0 ? String(out.stdout).trim() : ''
  const root = dir.endsWith('/.git') ? dir.slice(0, -5) : base
  if (root !== last) await $.state.set(ROOT, root)
  return root
}

async function memoryDir($: any, root: string): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  return `${home}/.claude/projects/${mangle(root)}/memory`
}

async function listKnown($: any): Promise<{ root: string; known: Known[] }> {
  const root = await repoRoot($)
  const bySlug = new Map<string, Known>()
  const mdir = await memoryDir($, root)
  const index: string = await $.fs.read(`${mdir}/MEMORY.md`).catch(() => '')
  const mem = ((await $.fs.list(mdir).catch(() => [])) as Entry[]).filter(
    f => f.kind === 'file' && /^chantier-.+\.md$/.test(f.name),
  )
  for (const f of mem) {
    const slug = f.name.replace(/^chantier-/, '').replace(/\.md$/, '')
    const title = new RegExp(`\\[([^\\]]+)\\]\\(${f.name.replace('.', '\\.')}\\)`).exec(index)?.[1] ?? slug
    bySlug.set(slug, { slug, title, keys: [], memory: `${mdir}/${f.name}` })
  }
  const cdir = `${root}/.superpowers/chantiers`
  const man = ((await $.fs.list(cdir).catch(() => [])) as Entry[]).filter(
    f => f.kind === 'file' && f.name.endsWith('.json'),
  )
  for (const f of man) {
    const slug = f.name.replace(/\.json$/, '')
    const text: string = await $.fs.read(`${cdir}/${f.name}`).catch(() => '')
    let parsed: Manifest | undefined
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
    const k = bySlug.get(slug) ?? { slug, title: slug, keys: [] }
    k.manifest = `${cdir}/${f.name}`
    if (parsed) {
      k.title = parsed.title
      for (const pr of expand(parsed.prs)) {
        if (pr.branch) k.keys.push(pr.branch.toLowerCase())
        if (pr.ledger) k.keys.push(pr.ledger.split('/').slice(-2, -1)[0]?.toLowerCase() ?? '')
      }
    }
    bySlug.set(slug, k)
  }
  for (const k of bySlug.values()) {
    const title = k.title.toLowerCase().replace(/^chantier\s+/, '')
    k.keys.push(`chantier-${k.slug}`, `chantier ${title}`, k.slug.length >= 6 ? k.slug : '')
  }
  return { root, known: [...bySlug.values()] }
}

const ghState = (s: string): PrStatus => (s === 'MERGED' ? 'merged' : s === 'OPEN' ? 'open' : 'closed')

// Quota GitHub épuisé : plus aucun appel gh jusqu'à cette heure. L'échéance est
// aussi dans $.store, partagée par toutes les sessions qui suivent un chantier.
const PAUSE = 15 * 60_000
const PAUSE_KEY = 'gh-pause-until'
let pausedUntil = 0

async function ghPausedUntil($: any): Promise<number> {
  const shared = Number((await $.store.get(PAUSE_KEY).catch(() => 0)) ?? 0)
  const until = Math.max(pausedUntil, shared)
  return Date.now() < until ? until : 0
}

async function gh($: any, root: string, args: string[]): Promise<any> {
  if (await ghPausedUntil($)) return undefined
  const out = await $.process.run(['gh', ...args], { cwd: root }).catch(() => undefined)
  if (!out || out.exitCode !== 0) {
    if (out && QUOTA.test(`${out.stderr ?? ''}\n${out.stdout ?? ''}`)) {
      pausedUntil = Date.now() + PAUSE
      await $.store.set(PAUSE_KEY, pausedUntil).catch(() => undefined)
    }
    return undefined
  }
  try {
    return JSON.parse(out.stdout || 'null')
  } catch {
    return undefined
  }
}

// État d'une PR : une PR mergée connue n'est plus demandée ; sinon gh, et sur
// échec le dernier état connu.
async function prState($: any, root: string, n: number, fields: string): Promise<GhPr | undefined> {
  const key = `pr:${root}:${n}`
  const known = (await $.store.get(key).catch(() => undefined)) as GhPr | undefined
  if (known?.state === 'MERGED') return known
  const v = await gh($, root, ['pr', 'view', String(n), '--json', fields])
  const fresh: GhPr | undefined = v
    ? { number: v.number, state: v.state, title: v.title ?? known?.title, summary: v.body != null ? summary(v.body) : known?.summary }
    : undefined
  if (fresh) await $.store.set(key, fresh).catch(() => undefined)
  return resolveState(fresh, known)
}

// PR d'une branche, même règle que prState.
async function branchState($: any, root: string, branch: string): Promise<GhPr | undefined> {
  const key = `branch:${root}:${branch}`
  const known = (await $.store.get(key).catch(() => undefined)) as GhPr | undefined
  if (known?.state === 'MERGED') return known
  const list = await gh($, root, ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state', '--limit', '1'])
  const fresh: GhPr | undefined = list?.[0] ? { number: list[0].number, state: list[0].state } : undefined
  if (fresh) await $.store.set(key, fresh).catch(() => undefined)
  return resolveState(fresh, known)
}

// Dossiers SDD du dépôt et de tous ses worktrees : un registre vit souvent dans
// le worktree de la PR, pas à la racine. Du plus récent au plus ancien.
async function sddDirs($: any, root: string): Promise<{ name: string; ledger: string }[]> {
  const out = await $.process.run(['git', 'worktree', 'list', '--porcelain'], { cwd: root }).catch(() => undefined)
  const trees = [root, ...(out && out.exitCode === 0 ? worktreePaths(String(out.stdout)) : [])]
  const seen = new Set<string>()
  const dirs: { name: string; ledger: string }[] = []
  for (const tree of [...new Set(trees)]) {
    const sdd = `${tree}/.superpowers/sdd`
    for (const d of (await $.fs.list(sdd).catch(() => [])) as Entry[]) {
      if (d.kind !== 'dir') continue
      const ledger = `${sdd}/${d.name}/progress.md`
      if (seen.has(ledger)) continue
      seen.add(ledger)
      dirs.push({ name: d.name, ledger })
    }
  }
  return dirs.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
}

async function sddRow($: any, root: string, id: string, plan: string, ledger: string): Promise<PrRow> {
  const planText: string = await $.fs.read(plan.startsWith('/') ? plan : `${root}/${plan}`).catch(() => '')
  const ledgerText: string = await $.fs.read(ledger.startsWith('/') ? ledger : `${root}/${ledger}`).catch(() => '')
  const ids = planTasks(planText, id)
  const { done, lastStep } = ledgerState(ledgerText, ids)
  const goal = /^\*\*Goal:\*\*\s*(.*)$/m.exec(planText)?.[1] ?? ''
  const tasksDone = ids.filter(t => done.has(t)).length
  return {
    id,
    title: /^#\s+(.*)$/m.exec(planText)?.[1]?.replace(/\s+—\s+Implementation Plan$/, '') ?? id,
    objective: summary(goal, 260),
    status: 'in_progress',
    tasksDone,
    tasksTotal: ids.length,
    nextTask: ids.find(t => !done.has(t)),
    lastStep,
    progress: ids.length ? (tasksDone / ids.length) * 0.95 : 0,
  }
}

async function fromManifest($: any, root: string, path: string): Promise<{ title: string; objective: string; prs: PrRow[] }> {
  const m: Manifest = JSON.parse(await $.fs.read(path))
  const slug = path.split('/').pop()?.replace(/\.json$/, '') ?? ''
  const dirs = await sddDirs($, root)
  const prs = await Promise.all(
    expand(m.prs).map(async (spec): Promise<PrRow> => {
      // Un élément sans plan ni registre dans le manifeste reprend ceux de son
      // dossier SDD : le manifeste n'est pas réécrit à chaque PR démarrée.
      const pr = { ...spec }
      if (!pr.plan || !pr.ledger) {
        for (const d of dirs.filter(n => sddMatches(n.name, slug, pr.id))) {
          const meta = ledgerMeta(await $.fs.read(d.ledger).catch(() => ''))
          if (!meta.plan) continue
          pr.plan ??= meta.plan
          pr.ledger = d.ledger
          pr.branch ??= meta.branch
          break
        }
      }
      pr.plan ??= pr.parentPlan
      // Plan connu sans registre : le registre dont l'en-tête suit ce plan (un même
      // plan peut servir plusieurs PR ; planTasks en garde la section de l'élément).
      if (pr.plan && !pr.ledger && manifestStatus(pr.status) !== 'merged') {
        for (const d of dirs) {
          const meta = ledgerMeta(await $.fs.read(d.ledger).catch(() => ''))
          if (meta.plan && samePlan(meta.plan, pr.plan)) {
            pr.ledger = d.ledger
            break
          }
        }
      }
      const row: PrRow =
        pr.plan && pr.ledger
          ? { ...(await sddRow($, root, pr.id, pr.plan, pr.ledger)), title: pr.title, objective: pr.objective }
          : { id: pr.id, title: pr.title, objective: pr.objective, status: 'planned', progress: 0 }
      const declared = manifestStatus(pr.status)
      const one =
        declared === 'merged'
          ? undefined
          : pr.github
            ? await prState($, root, pr.github, 'number,state')
            : pr.branch
              ? await branchState($, root, pr.branch)
              : undefined
      return applyState(row, declared, pr.github, one)
    }),
  )
  return { title: m.title, objective: m.objective, prs }
}

async function fromMemory($: any, root: string, k: Known): Promise<{ title: string; objective: string; prs: PrRow[] }> {
  const fm = frontmatter(await $.fs.read(k.memory))
  const numbers = prNumbers(`${fm.description ?? ''}\n${fm.body}`).slice(-MAX_GH)
  const prs: PrRow[] = []
  const views = await Promise.all(numbers.map(n => prState($, root, n, 'number,state,title,body')))
  for (const v of views) {
    if (!v) continue
    const status = ghState(v.state)
    prs.push({
      id: `#${v.number}`,
      title: v.title ?? `#${v.number}`,
      objective: v.summary ?? '',
      status,
      github: v.number,
      progress: status === 'merged' ? 1 : status === 'open' ? 0.9 : 0,
    })
  }
  // Plans en cours rattachés au chantier par le nom de leur dossier SDD.
  const dirs = (await sddDirs($, root)).filter(d => d.name.includes(k.slug))
  for (const d of dirs) {
    const first: string = (await $.fs.read(d.ledger).catch(() => '')).split('\n')[0] ?? ''
    const plan = /plan:\s*(\S+)/.exec(first)?.[1]
    if (plan) prs.push(await sddRow($, root, d.name.replace(/^\d{4}-\d{2}-\d{2}-/, ''), plan, d.ledger))
  }
  return { title: k.title, objective: fm.description ?? '', prs }
}

async function build($: any, slug: string): Promise<Report | undefined> {
  const { root, known } = await listKnown($)
  const k = known.find(c => c.slug === slug)
  if (!k) return undefined
  const base = k.manifest ? await fromManifest($, root, k.manifest) : await fromMemory($, root, k)
  const progress = base.prs.reduce((s, pr) => s + pr.progress, 0) / Math.max(1, base.prs.length)
  const paused = await ghPausedUntil($)
  const memo: string = k.memory ? await $.fs.read(k.memory).catch(() => '') : ''
  return {
    slug,
    title: base.title,
    objective: base.objective,
    source: k.manifest ? 'manifest' : 'memory',
    progress,
    merged: base.prs.filter(pr => pr.status === 'merged').length,
    total: base.prs.length,
    prs: base.prs,
    updatedAt: hhmm(Date.now()),
    ghPausedUntil: paused ? hhmm(paused) : undefined,
    inFlight: inFlight(base.prs),
    onHold: onHold(base.prs),
    lastNote: memo ? lastNote(frontmatter(memo).body) : undefined,
  }
}

// Phrase de /chantier et du toast : avancement, ce qui est en cours, puis en pause.
export function sentence(r: Pick<Report, 'title' | 'progress' | 'merged' | 'total' | 'inFlight' | 'onHold'>): string {
  const now = r.inFlight?.length ? ` En cours : ${r.inFlight.join(' ; ')}.` : ''
  const held = r.onHold?.length ? ` En pause : ${r.onHold.join(' ; ')}.` : ''
  return `${r.title} : ${pct(r.progress)} — ${r.merged}/${r.total} PR mergées.${now}${held}`
}

// Élément à reprendre : celui en cours ou en PR ouverte, sinon le premier à venir.
export function resumeTarget(prs: PrRow[]): PrRow | undefined {
  return prs.find(pr => pr.status === 'in_progress' || pr.status === 'open') ?? prs.find(pr => pr.status === 'planned')
}

// Consigne de /reprendre, envoyée comme un message de la personne : l'état du
// chantier, ce qu'il faut relire, puis reprendre le travail sans autre consigne.
export function resumePrompt(
  r: Pick<Report, 'title' | 'objective' | 'progress' | 'merged' | 'total' | 'prs' | 'inFlight' | 'onHold' | 'lastNote'>,
  sources: string[],
): string {
  const pr = resumeTarget(r.prs)
  const detail = pr
    ? [
        LABEL[pr.status],
        pr.tasksTotal ? `${pr.tasksDone}/${pr.tasksTotal} tâches` : '',
        pr.nextTask ? `prochaine tâche ${pr.nextTask}` : '',
        pr.lastStep ? `dernier pas noté : ${pr.lastStep}` : '',
      ]
        .filter(Boolean)
        .join(' ; ')
    : ''
  return [
    `Reprends le chantier « ${r.title} » là où il s'est arrêté.`,
    `Objectif : ${r.objective}`,
    `État : ${sentence(r)}`,
    pr
      ? `Élément à reprendre : ${pr.id} — ${pr.title} (${detail}).`
      : 'Tous les éléments sont fusionnés : vérifie qu’il ne reste rien à faire (documentation, feuille de route) et dis-le.',
    r.lastNote ? `Dernière note : ${r.lastNote}` : '',
    `Relis d'abord : ${sources.join(', ')} ; puis le plan et le registre SDD de l'élément, l'état git de sa branche (status, log) et la feuille de route du projet.`,
    'Détermine toi-même la prochaine action concrète, annonce-la en une phrase simple, puis enchaîne en suivant la méthodologie du projet (CLAUDE.md). Ne t’arrête que pour une question métier ou une validation qui revient à l’utilisatrice.',
  ]
    .filter(Boolean)
    .join('\n')
}

const hhmm = (t: number) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
const pct = (r: number) => `${Math.round(r * 100)} %`
const bar = (r: number, w = 24) => '█'.repeat(Math.round(r * w)) + '░'.repeat(w - Math.round(r * w))
const LABEL: Record<PrStatus, string> = { merged: 'mergée', open: 'PR ouverte', closed: 'fermée', in_progress: 'en cours', paused: 'en pause', planned: 'à venir' }
const COLOR: Record<PrStatus, string> = { merged: 'success', open: 'warning', closed: 'error', in_progress: 'suggestion', paused: 'warning', planned: 'inactive' }

// Recalcule le chantier de la session, met le statut et le panneau à jour.
async function refresh($: any, slug: string): Promise<Report | undefined> {
  const r = await build($, slug)
  if (!r) return undefined
  await $.state.set(CURRENT, slug)
  await $.state.set(REPORT, r)
  const live = r.prs.find(pr => pr.status === 'in_progress' || pr.status === 'open')
  const tag = live ? ` · ${live.id}${live.status === 'in_progress' && live.nextTask ? ` ${live.nextTask}` : ''}` : ''
  await $.ui.status(`${r.title} · ${pct(r.progress)} · ${r.merged}/${r.total} PR${tag}`)
  lastAt = Date.now()
  return r
}

let knownCache: Known[] = []
let lastAt = 0
// Calcul en cours : variable du module, remise à zéro par un rechargement, quand
// BUSY (état de session, qui survit) ne sert qu'à l'affichage.
let running = false
// Chaque session ouverte rafraîchit son chantier : 10 min, pas 2, pour ne pas
// épuiser à plusieurs le quota GitHub.
const EVERY = 600_000
const MIN_GAP = 15_000

// Rafraîchissement silencieux du chantier suivi : minuteur et appels d'outils
// qui le font avancer. Sans effet si rien n'est suivi ou si un calcul tourne.
async function quietRefresh($: any): Promise<void> {
  const { value: current } = await $.state.get(CURRENT)
  if (!current || running || Date.now() - lastAt < MIN_GAP) return
  running = true
  await $.state.set(BUSY, true)
  try {
    knownCache = (await listKnown($)).known
    await refresh($, current)
  } catch {
    // dépôt ou gh momentanément indisponibles : le prochain passage réessaie
  } finally {
    running = false
    await $.state.set(BUSY, false)
  }
}

// Bouton « Mettre à jour » du panneau : relit manifeste, mémoire, registres SDD
// et états GitHub de chaque élément ; « mise à jour… » s'affiche pendant le calcul.
async function pressRefresh($: any, slug: string): Promise<void> {
  if (running) return
  running = true
  await $.state.set(BUSY, true)
  try {
    knownCache = (await listKnown($)).known
    const r = await refresh($, slug)
    const pause = r?.ghPausedUntil ? ` GitHub en pause (quota) jusqu’à ${r.ghPausedUntil} : états connus.` : ''
    await $.ui.toast(r ? `${sentence(r)}${pause}` : `Chantier « ${slug} » introuvable.`)
  } finally {
    running = false
    await $.state.set(BUSY, false)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'chantier',
      description: 'Chantier de la session : objectif, avancement et PR (/chantier [nom|liste])',
    })
    await $.command.register({
      name: 'reprendre',
      description: 'Reprend le travail du chantier là où il s’est arrêté (/reprendre [nom])',
      argumentHint: '[nom]',
    })
    await $.state.set(BUSY, false)
    $.clock.every(EVERY, () => void quietRefresh($))
    // Un dépôt illisible au démarrage ne doit pas priver la session du panneau.
    try {
      knownCache = (await listKnown($)).known
      const { value: current } = await $.state.get(CURRENT)
      if (current) await refresh($, current)
    } catch {
      knownCache = []
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const ran = await next(e)
    const slug = detect(e.text, knownCache)
    const { value: current } = await $.state.get(CURRENT)
    if (slug && slug !== current) await refresh($, slug)
    return ran
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const { value: current } = await $.state.get(CURRENT)
    const call = JSON.stringify(e)
    if (!current) {
      const slug = detect(call, knownCache)
      if (slug) await refresh($, slug)
    } else if (CHANGES.test(call)) await quietRefresh($)
    return ran
  })

  on('command.run', { command: 'chantier' }, async ($, e) => {
    const { known } = await listKnown($)
    knownCache = known
    const arg = e.args.trim()
    if (arg === 'liste' || known.length === 0) {
      return {
        text: known.length
          ? `Chantiers : ${known.map(k => k.slug).join(', ')}. /chantier <nom> pour en suivre un.`
          : 'Aucun chantier trouvé (ni .superpowers/chantiers/*.json, ni mémoire chantier-*.md).',
      }
    }
    const { value: current } = await $.state.get(CURRENT)
    const slug = arg ? detect(arg, known) ?? known.find(k => k.slug === arg)?.slug : current ?? undefined
    if (!slug) return { text: 'Aucun chantier détecté pour cette session. /chantier liste, puis /chantier <nom>.' }
    const r = await refresh($, slug)
    if (!r) return { text: `Chantier « ${slug} » introuvable.` }
    await $.ui.open({ id: PANE, title: 'Chantier' })
    return { text: sentence(r) }
  })

  // Chantier choisi : l'argument, sinon celui suivi par la session, sinon celui
  // de la branche courante, sinon le seul connu.
  on('command.run', { command: 'reprendre' }, async ($, e) => {
    const { root, known } = await listKnown($)
    knownCache = known
    if (known.length === 0) return { text: 'Aucun chantier trouvé (ni .superpowers/chantiers/*.json, ni mémoire chantier-*.md).' }
    const arg = e.args.trim()
    const { value: current } = await $.state.get(CURRENT)
    const out = await $.process.run(['git', 'branch', '--show-current'], { cwd: root }).catch(() => undefined)
    const branch = out && out.exitCode === 0 ? String(out.stdout).trim() : ''
    const slug = arg
      ? detect(arg, known) ?? known.find(k => k.slug === arg)?.slug
      : current ?? (branch ? detect(branch, known) : undefined) ?? (known.length === 1 ? known[0]?.slug : undefined)
    if (!slug) return { text: `Quel chantier reprendre ? ${known.map(k => `/reprendre ${k.slug}`).join(', ')}.` }
    const r = await refresh($, slug)
    const k = known.find(c => c.slug === slug)
    if (!r || !k) return { text: `Chantier « ${slug} » introuvable.` }
    const sources = [k.manifest, k.memory].filter((p): p is string => !!p).map(p => p.replace(`${root}/`, ''))
    // Envoyée depuis la commande, la consigne attendrait le tour que la commande
    // tient : un minuteur la soumet juste après, comme un message de la personne.
    const text = resumePrompt(r, sources)
    $.clock.after(1, () => void $.prompt.submit({ text, asUser: true }).catch(() => $.ui.toast('La reprise n’a pas pu être lancée : /reprendre à nouveau.')))
    return { text: `Reprise — ${sentence(r)}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { value: r } = await $.state.get(REPORT)
    const { value: busy } = await $.state.get(BUSY)
    if (!r) return <Text dimColor>Aucun chantier détecté : /chantier liste.</Text>
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          <Box flexDirection="column" flexShrink={1}>
            <Text bold>{r.title}</Text>
            <Text wrap="wrap">{r.objective}</Text>
          </Box>
          <Button
            key="refresh"
            label={busy ? 'Mise à jour…' : 'Mettre à jour'}
            hotkey="u"
            dimColor={!!busy}
            onPress={() => pressRefresh($, r.slug)}
          />
        </Box>
        <Text>
          {bar(r.progress)} {pct(r.progress)} · {r.merged}/{r.total} PR mergées · maj {r.updatedAt}
          {r.source === 'memory' ? ' · d’après la mémoire' : ''}
          {r.ghPausedUntil ? ` · GitHub en pause (quota) jusqu’à ${r.ghPausedUntil}, états connus` : ''}
        </Text>
        {r.inFlight?.length ? (
          <Box flexDirection="column">
            {r.inFlight.map(line => (
              <Text key={line} color="suggestion" wrap="wrap">
                ▶ En cours : {line}
              </Text>
            ))}
          </Box>
        ) : null}
        {r.onHold?.length ? (
          <Box flexDirection="column">
            {r.onHold.map(line => (
              <Text key={line} color="warning" wrap="wrap">
                ‖ En pause : {line}
              </Text>
            ))}
          </Box>
        ) : null}
        {r.lastNote ? (
          <Text dimColor wrap="wrap">
            Dernière note : {r.lastNote}
          </Text>
        ) : null}
        {r.prs.map(pr => (
          <Box flexDirection="column" key={pr.id}>
            <Text>
              <Text color={COLOR[pr.status]}>{bar(pr.progress, 10)}</Text> <Text bold>{pr.id}</Text> {pr.title}{' '}
              <Text color={COLOR[pr.status]}>
                [{LABEL[pr.status]}
                {pr.github && !pr.id.startsWith('#') ? ` #${pr.github}` : ''}
                {pr.tasksTotal ? ` · ${pr.tasksDone}/${pr.tasksTotal} tâches` : ''}]
              </Text>
            </Text>
            <Box paddingLeft={11} flexDirection="column">
              {pr.objective ? <Text dimColor wrap="wrap">{pr.objective}</Text> : null}
              {pr.status === 'in_progress' && pr.nextTask ? (
                <Text dimColor wrap="wrap">
                  Prochaine : Task {pr.nextTask}
                  {pr.lastStep ? ` · dernier pas : ${pr.lastStep}` : ''}
                </Text>
              ) : null}
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}
