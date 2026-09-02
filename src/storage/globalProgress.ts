export interface GlobalProgress {
  active: boolean
  label: string
  done: number
  total: number
}

let progress: GlobalProgress = { active: false, label: '', done: 0, total: 0 }
const listeners = new Set<() => void>()

export function subscribeGlobalProgress(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getGlobalProgress(): GlobalProgress {
  return progress
}

export function setGlobalProgress(next: Partial<GlobalProgress>): void {
  progress = { ...progress, ...next }
  listeners.forEach((listener) => listener())
}
