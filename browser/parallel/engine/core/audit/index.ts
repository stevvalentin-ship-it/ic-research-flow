// ============================================================================
// audit/index.ts —— 规则审核类型化入口(核心在 audit.core.js)
// ============================================================================
import './audit.core.js';

export interface AuditBlock {
  id: string;
  type: string;
  text?: string;
  order: number;
}

export interface TranslationPair {
  enBlockId: string;
  zhBlockId: string;
  zhText: string;
}

export interface AuditTerm {
  zh: string;
  en: string;
  abbr?: string;
}

export interface AuditIssue {
  id: string;
  kind: 'rule';
  severity: 'error' | 'warn';
  blockId?: string;
  message: string;
  rule: string;
  resolved: boolean;
}

export interface RuleAuditResult {
  issues: AuditIssue[];
  pass: boolean;
  errors: number;
  warns: number;
  report: {
    enLabels: string[];
    zhLabels: string[];
    enSec: string[];
    zhSec: string[];
    enDollar: number;
    zhDollar: number;
    missingNums: number[];
  };
}

interface Core {
  runRuleAudit(input: {
    enBlocks: AuditBlock[];
    zhBlocks: AuditBlock[];
    pairs?: TranslationPair[];
    terms?: AuditTerm[];
    allowUnpaired?: string[];
  }): RuleAuditResult;
  extractSectionNumbers(blocks: AuditBlock[]): string[];
  extractNumberedLabels(blocks: AuditBlock[]): { label: string; id: string; order: number }[];
  extractNumbers(text: string): number[];
}

const core = (globalThis as any).PaperParallelAudit as Core;

export const runRuleAudit = core.runRuleAudit.bind(core) as Core['runRuleAudit'];
export const extractSectionNumbers = core.extractSectionNumbers.bind(core) as Core['extractSectionNumbers'];
export const extractNumberedLabels = core.extractNumberedLabels.bind(core) as Core['extractNumberedLabels'];
export const extractNumbers = core.extractNumbers.bind(core) as Core['extractNumbers'];
