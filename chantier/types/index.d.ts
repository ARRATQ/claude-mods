export type PrStatus = 'merged' | 'open' | 'closed' | 'in_progress' | 'paused' | 'planned'

export type PrRow = {
  id: string
  title: string
  objective: string
  status: PrStatus
  github?: number
  tasksDone?: number
  tasksTotal?: number
  nextTask?: string
  lastStep?: string
  progress: number
}

export type Report = {
  slug: string
  title: string
  objective: string
  source: 'manifest' | 'memory'
  progress: number
  merged: number
  total: number
  prs: PrRow[]
  updatedAt: string
  // Quota GitHub épuisé : heure de reprise des appels gh (états affichés = derniers connus).
  ghPausedUntil?: string
  // Éléments en cours ou en PR ouverte, une phrase chacun.
  inFlight?: string[]
  // Éléments mis en pause dans le manifeste, une phrase chacun.
  onHold?: string[]
  // Dernière entrée datée de la fiche mémoire du chantier.
  lastNote?: string
}

declare module 'claude-code' {
  interface PluginState {
    chantier: { report: Report | null; current: string | null; busy: boolean | null; root: string | null }
  }
}
