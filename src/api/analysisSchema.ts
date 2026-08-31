import { IC_DOMAINS, type PaperAnalysis, type PaperFacets, type PaperReference, type Evidence } from '../domain/types'

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : {}
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export function extractJsonObject(raw: string): UnknownRecord {
  const cleaned = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim()
  const start = cleaned.indexOf('{')
  if (start < 0) throw new Error('MODEL_JSON_MISSING')

  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < cleaned.length; index += 1) {
    const character = cleaned[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\' && quoted) {
      escaped = true
      continue
    }
    if (character === '"') quoted = !quoted
    if (quoted) continue
    if (character === '{') depth += 1
    if (character === '}') depth -= 1
    if (depth === 0) return JSON.parse(cleaned.slice(start, index + 1)) as UnknownRecord
  }
  throw new Error('MODEL_JSON_INCOMPLETE')
}

function normalizeFacets(value: unknown): PaperFacets {
  const record = asRecord(value)
  return {
    objects: strings(record.objects),
    problems: strings(record.problems),
    methods: strings(record.methods),
    processNodes: strings(record.processNodes),
    metrics: strings(record.metrics),
    applications: strings(record.applications),
    findings: strings(record.findings),
    limitations: strings(record.limitations),
  }
}

export function normalizePaperAnalysis(paperId: string, value: unknown): PaperAnalysis {
  const record = asRecord(value)
  const domains = (Array.isArray(record.domains) ? record.domains : [])
    .map(asRecord)
    .filter((domain) => IC_DOMAINS.includes(domain.domain as (typeof IC_DOMAINS)[number]))
    .filter((domain) => Number(domain.confidence) >= 0.55)
    .map((domain) => ({
      domain: domain.domain as (typeof IC_DOMAINS)[number],
      confidence: Math.min(1, Math.max(0, Number(domain.confidence))),
      evidencePage: Number.isFinite(Number(domain.evidencePage)) ? Number(domain.evidencePage) : undefined,
      reason: typeof domain.reason === 'string' ? domain.reason : '',
    }))

  const references: PaperReference[] = (Array.isArray(record.references) ? record.references : []).map((item) => {
    const reference = asRecord(item)
    const allowed = ['foundation', 'extends', 'validates', 'contradicts', 'background']
    return {
      title: typeof reference.title === 'string' ? reference.title : '',
      authors: strings(reference.authors),
      year: Number.isFinite(Number(reference.year)) ? Number(reference.year) : undefined,
      doi: typeof reference.doi === 'string' ? reference.doi : undefined,
      relation: allowed.includes(String(reference.relation))
        ? (reference.relation as PaperReference['relation'])
        : 'background',
      evidencePage: Number.isFinite(Number(reference.evidencePage)) ? Number(reference.evidencePage) : undefined,
    }
  }).filter((reference) => reference.title)

  const evidence: Evidence[] = (Array.isArray(record.evidence) ? record.evidence : []).map((item) => {
    const entry = asRecord(item)
    return {
      page: Number.isFinite(Number(entry.page)) ? Number(entry.page) : 1,
      quote: typeof entry.quote === 'string' ? entry.quote : '',
      label: typeof entry.label === 'string' ? entry.label : '关键证据',
    }
  }).filter((entry) => entry.quote)

  return {
    paperId,
    domains,
    facets: normalizeFacets(record.facets),
    keywordsZh: strings(record.keywordsZh),
    keywordsEn: strings(record.keywordsEn),
    references,
    summary: typeof record.summary === 'string' ? record.summary : '',
    evidence,
    analyzedAt: Date.now(),
  }
}
