// ============================================================================
// review/index.ts —— AI 复审/门禁/项目包 类型化入口(核心在 review.core.js)
// ============================================================================
import './review.core.js';

export interface ReviewPair {
  enBlockId: string;
  zhBlockId: string;
  enText: string;
  zhText: string;
}

export interface ReviewIssue {
  id: string;
  kind: 'rule' | 'ai';
  severity: 'error' | 'warn';
  blockId?: string;
  message: string;
  rule: string;
  resolved: boolean;
}

export interface ProjectPackage {
  schema: 'paper-parallel.project.v1';
  mode: 'A' | 'B';
  enDoc: unknown;
  zhDoc: unknown;
  units: unknown[];
  spans: unknown[];
  terms: unknown[];
  issues: ReviewIssue[];
  auditPassed: boolean;
  generatedAt: string;
  checksum: string;
}

interface Core {
  parseLlmJson(text: string): any;
  runAiReview(
    pairs: ReviewPair[],
    opts: {
      translate: (ctx: any) => Promise<string>;
      systemPrompt?: string;
      userPrompt?: string;
      onProgress?: (evt: any) => void;
    },
  ): Promise<{ issues: ReviewIssue[]; pass: boolean }>;
  combineIssues(ruleIssues: ReviewIssue[], aiIssues: ReviewIssue[]): {
    issues: ReviewIssue[];
    unresolvedErrors: number;
    unresolvedWarns: number;
  };
  isApproved(issues: ReviewIssue[]): boolean;
  resolveIssue(issues: ReviewIssue[], id: string, resolved?: boolean): ReviewIssue[];
  buildProjectPackage(input: {
    mode: 'A' | 'B';
    enDoc: unknown;
    zhDoc: unknown;
    units: unknown[];
    spans: unknown[];
    terms: unknown[];
    issues: ReviewIssue[];
    auditPassed: boolean;
  }): ProjectPackage;
  validateProjectPackage(pkg: ProjectPackage): { ok: boolean; errors: string[] };
  fnv1a(str: string): string;
}

const core = (globalThis as any).PaperParallelReview as Core;

export const parseLlmJson = core.parseLlmJson.bind(core) as Core['parseLlmJson'];
export const runAiReview = core.runAiReview.bind(core) as Core['runAiReview'];
export const combineIssues = core.combineIssues.bind(core) as Core['combineIssues'];
export const isApproved = core.isApproved.bind(core) as Core['isApproved'];
export const resolveIssue = core.resolveIssue.bind(core) as Core['resolveIssue'];
export const buildProjectPackage = core.buildProjectPackage.bind(core) as Core['buildProjectPackage'];
export const validateProjectPackage = core.validateProjectPackage.bind(core) as Core['validateProjectPackage'];
export const fnv1a = core.fnv1a.bind(core) as Core['fnv1a'];
