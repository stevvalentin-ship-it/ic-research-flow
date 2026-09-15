import type { VisionRegionType } from './protocol';
import type { VisionPagePlan } from './pagePlan';

export type CrossPageMemberRole = 'head' | 'continuation' | 'tail';
export type WeakCrossPageEvidence =
  | 'page-edge-continuity'
  | 'repeated-table-header'
  | 'same-column'
  | 'text-anchor-continuity'
  | 'graphic-continuity';

export interface CrossPageAssetCandidateMember {
  pageIndex: number;
  regionId: string;
  role: CrossPageMemberRole;
}

export interface CrossPageAssetCandidate {
  kind: Extract<VisionRegionType, 'figure' | 'table' | 'code'>;
  members: CrossPageAssetCandidateMember[];
  captionPageIndex?: number;
  captionAnchor?: string;
  strongEvidence?: 'continued-label' | 'same-numbered-caption';
  weakEvidence: WeakCrossPageEvidence[];
  provenance: string[];
}

export interface CrossPageAssetGroup extends CrossPageAssetCandidate {
  id: string;
  status: 'validated';
}

export interface AcceptedDocumentPlan {
  schemaVersion: 1;
  documentPlanDigest: string;
  pagePlanDigests: Array<{ pageIndex: number; planDigest: string }>;
  crossPageAssetGroups: CrossPageAssetGroup[];
}

export interface CrossPageRelationIssue {
  code:
    | 'cross-page.insufficient-evidence'
    | 'cross-page.invalid-members'
    | 'cross-page.unknown-region'
    | 'cross-page.multiple-group-membership'
    | 'cross-page.invalid-caption-owner'
    | 'cross-page.contradictory-evidence';
  candidateIndex: number;
  message: string;
}

function normalizedLabel(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  return normalized || undefined;
}

function numberedLabelIdentity(value: string | undefined): string | undefined {
  const match = value?.match(/\b(fig(?:ure)?|table|algorithm|code)\s*\.?\s*(\d+(?:[.-]\d+)*|[IVXLCDM]+)\b/i);
  if (!match) return undefined;
  const kind = /^fig/i.test(match[1]!) ? 'figure' : match[1]!.toLocaleLowerCase();
  return `${kind}:${match[2]!.toLocaleLowerCase()}`;
}

function contradictoryPageLink(
  tail: VisionPagePlan['regions'][number],
  head: VisionPagePlan['regions'][number],
): boolean {
  if (tail.crossPageHint === 'none' || head.crossPageHint === 'none'
    || tail.crossPageHint === 'ends' || head.crossPageHint === 'starts') return true;
  const tailIdentity = numberedLabelIdentity(tail.visibleLabel);
  const headIdentity = numberedLabelIdentity(head.visibleLabel);
  return Boolean(tailIdentity && headIdentity && tailIdentity !== headIdentity);
}

/** Produces candidates only from adjacent page-edge regions; validation remains authoritative. */
export function inferCrossPageAssetCandidates(
  plans: readonly VisionPagePlan[],
): CrossPageAssetCandidate[] {
  const byPage = new Map(plans.map((plan) => [plan.pageIndex, plan]));
  type Link = {
    tailPageIndex: number;
    tail: VisionPagePlan['regions'][number];
    headPageIndex: number;
    head: VisionPagePlan['regions'][number];
    geometryDistance: number;
    hintCompatible: boolean;
    weakEvidence: WeakCrossPageEvidence[];
    strongEvidence?: CrossPageAssetCandidate['strongEvidence'];
  };
  const possibleLinks: Link[] = [];
  for (const plan of [...plans].sort((left, right) => left.pageIndex - right.pageIndex)) {
    const next = byPage.get(plan.pageIndex + 1);
    if (!next) continue;
    const tails = plan.regions.filter((region) => (
      ['figure', 'table', 'code'].includes(region.type) && region.bbox[1] + region.bbox[3] >= 900
    ));
    const heads = next.regions.filter((region) => (
      ['figure', 'table', 'code'].includes(region.type) && region.bbox[1] <= 120
    ));
    for (const tail of tails) {
      for (const head of heads.filter((candidate) => candidate.type === tail.type)) {
          if (contradictoryPageLink(tail, head)) continue;
          const sameColumn = head.column === tail.column;
          const geometryDistance = Math.abs(head.bbox[0] - tail.bbox[0])
            + Math.abs(head.bbox[2] - tail.bbox[2]);
          const tailLabel = normalizedLabel(tail.visibleLabel);
          const headLabel = normalizedLabel(head.visibleLabel);
          const sameLabel = Boolean(tailLabel && headLabel && tailLabel === headLabel);
          const continued = /\bcont(?:inued|\.)?\b/i.test(`${tail.visibleLabel ?? ''} ${head.visibleLabel ?? ''}`);
          const hintCompatible = ['starts', 'continues'].includes(tail.crossPageHint ?? '')
            && ['continues', 'ends'].includes(head.crossPageHint ?? '');
          const weakEvidence: WeakCrossPageEvidence[] = ['page-edge-continuity'];
          if (sameColumn) weakEvidence.push('same-column');
          if (geometryDistance <= 100) weakEvidence.push('graphic-continuity');
          if (tail.type === 'table' && sameLabel) weakEvidence.push('repeated-table-header');
          const link: Link = {
            tailPageIndex: plan.pageIndex,
            tail,
            headPageIndex: next.pageIndex,
            head,
            geometryDistance,
            hintCompatible,
            weakEvidence,
            strongEvidence: continued
              ? 'continued-label' as const
              : sameLabel
                ? 'same-numbered-caption' as const
                : undefined,
          };
          // Automatic inference is deliberately stricter than validating an
          // explicit V4.1 Flash candidate: without a visible continued label, require
          // page-edge, column and graphic continuity together.
          if (link.strongEvidence
            || new Set(link.weakEvidence).size >= (link.hintCompatible ? 2 : 3)) {
            possibleLinks.push(link);
          }
      }
    }
  }

  // Select a deterministic one-to-one edge matching.  A region may be the
  // head of one edge and the tail of the next edge, which is what allows a
  // table or algorithm to span three or more pages without being split into
  // overlapping two-page groups.
  possibleLinks.sort((left, right) => (
    Number(Boolean(right.strongEvidence)) - Number(Boolean(left.strongEvidence))
    || Number(right.hintCompatible) - Number(left.hintCompatible)
    || new Set(right.weakEvidence).size - new Set(left.weakEvidence).size
    || left.geometryDistance - right.geometryDistance
    || left.tailPageIndex - right.tailPageIndex
    || left.tail.id.localeCompare(right.tail.id)
    || left.head.id.localeCompare(right.head.id)
  ));
  const outgoing = new Map<string, Link>();
  const incoming = new Set<string>();
  for (const link of possibleLinks) {
    const tailKey = `${link.tailPageIndex}:${link.tail.id}`;
    const headKey = `${link.headPageIndex}:${link.head.id}`;
    if (outgoing.has(tailKey) || incoming.has(headKey)) continue;
    outgoing.set(tailKey, link);
    incoming.add(headKey);
  }

  const candidates: CrossPageAssetCandidate[] = [];
  const visited = new Set<string>();
  for (const [startKey] of [...outgoing.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (incoming.has(startKey) || visited.has(startKey)) continue;
    const chain: Link[] = [];
    let currentKey: string | undefined = startKey;
    while (currentKey) {
      const link = outgoing.get(currentKey);
      if (!link || visited.has(currentKey)) break;
      visited.add(currentKey);
      chain.push(link);
      currentKey = `${link.headPageIndex}:${link.head.id}`;
    }
    if (!chain.length) continue;
    const first = chain[0]!;
    const regions = [first.tail, ...chain.map((link) => link.head)];
    const pageIndices = [first.tailPageIndex, ...chain.map((link) => link.headPageIndex)];
    const captionIndex = regions.findIndex((region) => (
      Boolean(normalizedLabel(region.visibleLabel)) && region.captionPosition !== 'none'
    ));
    const strongEvidence = chain.find((link) => link.strongEvidence)?.strongEvidence;
    candidates.push({
      kind: first.tail.type as CrossPageAssetCandidate['kind'],
      members: regions.map((region, index) => ({
        pageIndex: pageIndices[index]!,
        regionId: region.id,
        role: index === 0 ? 'head' : index === regions.length - 1 ? 'tail' : 'continuation',
      })),
      ...(captionIndex >= 0 ? {
        captionPageIndex: pageIndices[captionIndex],
        captionAnchor: normalizedLabel(regions[captionIndex]!.visibleLabel),
      } : {}),
      ...(strongEvidence ? { strongEvidence } : {}),
      weakEvidence: [...new Set(chain.flatMap((link) => link.weakEvidence))],
      provenance: [
        'local-page-edge-inference',
        ...(chain.some((link) => link.hintCompatible) ? ['exp-page-continuation-proposal'] : []),
      ],
    });
  }
  return candidates;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function digestAcceptedDocumentPlan(
  plans: readonly VisionPagePlan[],
  groups: readonly CrossPageAssetGroup[],
): string {
  return digestAcceptedDocumentPlanParts(
    plans.map((plan) => ({ pageIndex: plan.pageIndex, planDigest: plan.planDigest })),
    groups,
  );
}

function digestAcceptedDocumentPlanParts(
  pagePlanDigests: readonly { pageIndex: number; planDigest: string }[],
  groups: readonly CrossPageAssetGroup[],
): string {
  const normalized = {
    pages: [...pagePlanDigests]
      .sort((left, right) => left.pageIndex - right.pageIndex)
      .map((plan) => ({ pageIndex: plan.pageIndex, planDigest: plan.planDigest })),
    crossPageAssetGroups: [...groups]
      .map((group) => ({
        id: group.id,
        kind: group.kind,
        members: [...group.members].sort((left, right) => left.pageIndex - right.pageIndex),
        captionPageIndex: group.captionPageIndex,
        captionAnchor: group.captionAnchor,
        strongEvidence: group.strongEvidence,
        weakEvidence: [...group.weakEvidence].sort(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  return stableHash(JSON.stringify(normalized));
}

/** Strictly reconstructs a persisted document plan before it influences invalidation or commits. */
export function parseAcceptedDocumentPlan(value: unknown): AcceptedDocumentPlan {
  const root = documentPlanRecord(value, 'documentPlan');
  documentPlanKeys(root, [
    'schemaVersion', 'documentPlanDigest', 'pagePlanDigests', 'crossPageAssetGroups',
  ], 'documentPlan');
  if (root.schemaVersion !== 1
    || !Array.isArray(root.pagePlanDigests) || root.pagePlanDigests.length > 10_000
    || !Array.isArray(root.crossPageAssetGroups) || root.crossPageAssetGroups.length > 1_000) {
    throw new Error('文档页面计划版本或数组字段无效');
  }
  const pagePlanDigests = root.pagePlanDigests.map((value, index) => {
    const item = documentPlanRecord(value, `pagePlanDigests[${index}]`);
    documentPlanKeys(item, ['pageIndex', 'planDigest'], `pagePlanDigests[${index}]`);
    if (!Number.isInteger(item.pageIndex) || (item.pageIndex as number) < 0) {
      throw new Error(`文档页面计划 pagePlanDigests[${index}].pageIndex 无效`);
    }
    return {
      pageIndex: item.pageIndex as number,
      planDigest: documentPlanText(item.planDigest, `pagePlanDigests[${index}].planDigest`, 160),
    };
  });
  if (new Set(pagePlanDigests.map((item) => item.pageIndex)).size !== pagePlanDigests.length) {
    throw new Error('文档页面计划包含重复页面');
  }
  const groups = root.crossPageAssetGroups.map((value, index): CrossPageAssetGroup => {
    const item = documentPlanRecord(value, `crossPageAssetGroups[${index}]`);
    documentPlanKeys(item, [
      'id', 'status', 'kind', 'members', 'captionPageIndex', 'captionAnchor',
      'strongEvidence', 'weakEvidence', 'provenance',
    ], `crossPageAssetGroups[${index}]`);
    if (item.status !== 'validated' || !['figure', 'table', 'code'].includes(String(item.kind))
      || !Array.isArray(item.members) || item.members.length < 2 || item.members.length > 1_000
      || !Array.isArray(item.weakEvidence) || !Array.isArray(item.provenance)) {
      throw new Error(`文档页面计划 crossPageAssetGroups[${index}] 字段无效`);
    }
    const members = item.members.map((value, memberIndex): CrossPageAssetCandidateMember => {
      const member = documentPlanRecord(value, `crossPageAssetGroups[${index}].members[${memberIndex}]`);
      documentPlanKeys(member, ['pageIndex', 'regionId', 'role'], `crossPageAssetGroups[${index}].members[${memberIndex}]`);
      if (!Number.isInteger(member.pageIndex) || (member.pageIndex as number) < 0
        || !['head', 'continuation', 'tail'].includes(String(member.role))) {
        throw new Error(`文档页面计划 crossPageAssetGroups[${index}].members[${memberIndex}] 无效`);
      }
      return {
        pageIndex: member.pageIndex as number,
        regionId: documentPlanText(member.regionId, `crossPageAssetGroups[${index}].members[${memberIndex}].regionId`, 160),
        role: member.role as CrossPageMemberRole,
      };
    });
    const pages = members.map((member) => member.pageIndex);
    if (members[0]?.role !== 'head' || members.at(-1)?.role !== 'tail'
      || members.slice(1, -1).some((member) => member.role !== 'continuation')
      || pages.some((page, pageIndex) => pageIndex > 0 && page !== pages[pageIndex - 1]! + 1)) {
      throw new Error(`文档页面计划 crossPageAssetGroups[${index}] 成员顺序无效`);
    }
    const weakEvidence = item.weakEvidence.map((evidence, evidenceIndex) => documentPlanEnum(
      evidence,
      ['page-edge-continuity', 'repeated-table-header', 'same-column', 'text-anchor-continuity', 'graphic-continuity'] as const,
      `crossPageAssetGroups[${index}].weakEvidence[${evidenceIndex}]`,
    ));
    const captionPageIndex = item.captionPageIndex;
    if (captionPageIndex !== undefined
      && (!Number.isInteger(captionPageIndex) || !pages.includes(captionPageIndex as number))) {
      throw new Error(`文档页面计划 crossPageAssetGroups[${index}].captionPageIndex 无效`);
    }
    return {
      id: documentPlanText(item.id, `crossPageAssetGroups[${index}].id`, 200),
      status: 'validated',
      kind: item.kind as CrossPageAssetGroup['kind'],
      members,
      ...(captionPageIndex === undefined ? {} : { captionPageIndex: captionPageIndex as number }),
      ...(item.captionAnchor === undefined ? {} : {
        captionAnchor: documentPlanText(item.captionAnchor, `crossPageAssetGroups[${index}].captionAnchor`, 240),
      }),
      ...(item.strongEvidence === undefined ? {} : {
        strongEvidence: documentPlanEnum(
          item.strongEvidence,
          ['continued-label', 'same-numbered-caption'] as const,
          `crossPageAssetGroups[${index}].strongEvidence`,
        ),
      }),
      weakEvidence,
      provenance: item.provenance.map((entry, entryIndex) => documentPlanText(
        entry, `crossPageAssetGroups[${index}].provenance[${entryIndex}]`, 160,
      )),
    };
  });
  const claimed = new Set<string>();
  for (const group of groups) {
    for (const member of group.members) {
      const key = `${member.pageIndex}:${member.regionId}`;
      if (claimed.has(key)) throw new Error(`文档页面计划跨页成员重复归属 ${key}`);
      claimed.add(key);
    }
  }
  const documentPlanDigest = documentPlanText(root.documentPlanDigest, 'documentPlan.documentPlanDigest', 160);
  if (digestAcceptedDocumentPlanParts(pagePlanDigests, groups) !== documentPlanDigest) {
    throw new Error('文档页面计划摘要不一致');
  }
  return { schemaVersion: 1, documentPlanDigest, pagePlanDigests, crossPageAssetGroups: groups };
}

function documentPlanRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`文档页面计划 ${path} 必须为对象`);
  return value as Record<string, unknown>;
}

function documentPlanKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const keys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) throw new Error(`文档页面计划 ${path} 包含未知字段 ${unknown}`);
}

function documentPlanText(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`文档页面计划 ${path} 字符串无效`);
  }
  return value;
}

function documentPlanEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`文档页面计划 ${path} 枚举无效`);
  return value as T;
}

export function validateCrossPageAssetCandidates(
  plans: readonly VisionPagePlan[],
  candidates: readonly CrossPageAssetCandidate[],
): { groups: CrossPageAssetGroup[]; issues: CrossPageRelationIssue[] } {
  const regionByKey = new Map(plans.flatMap((plan) => plan.regions.map((region) => [
    `${plan.pageIndex}:${region.id}`,
    region,
  ] as const)));
  const groups: CrossPageAssetGroup[] = [];
  const issues: CrossPageRelationIssue[] = [];
  const claimedMembers = new Map<string, number>();
  candidates.forEach((candidate, candidateIndex) => {
    const members = [...candidate.members].sort((left, right) => left.pageIndex - right.pageIndex);
    const uniquePages = new Set(members.map((member) => member.pageIndex));
    const adjacent = members.every((member, index) => (
      index === 0 || member.pageIndex === members[index - 1]!.pageIndex + 1
    ));
    const rolesValid = members.length >= 2
      && members[0]?.role === 'head'
      && members[members.length - 1]?.role === 'tail'
      && members.slice(1, -1).every((member) => member.role === 'continuation')
      && uniquePages.size === members.length
      && adjacent;
    if (!rolesValid) {
      issues.push({
        code: 'cross-page.invalid-members', candidateIndex,
        message: '跨页资产成员必须位于连续页面，并按 head/continuation/tail 排列',
      });
      return;
    }
    const unknown = members.find((member) => {
      const region = regionByKey.get(`${member.pageIndex}:${member.regionId}`);
      return !region || region.type !== candidate.kind;
    });
    if (unknown) {
      issues.push({
        code: 'cross-page.unknown-region', candidateIndex,
        message: `跨页资产引用未知或类型不一致的区域 ${unknown.regionId}`,
      });
      return;
    }
    const numberedIdentities = new Set(members.flatMap((member) => {
      const identity = numberedLabelIdentity(regionByKey.get(`${member.pageIndex}:${member.regionId}`)!.visibleLabel);
      return identity ? [identity] : [];
    }));
    const contradictsMember = numberedIdentities.size > 1 || members.some((member, index) => index > 0 && contradictoryPageLink(
      regionByKey.get(`${members[index - 1]!.pageIndex}:${members[index - 1]!.regionId}`)!,
      regionByKey.get(`${member.pageIndex}:${member.regionId}`)!,
    ));
    if (contradictsMember) {
      issues.push({
        code: 'cross-page.contradictory-evidence', candidateIndex,
        message: '跨页资产成员的明确连续性提示或可见编号互相矛盾',
      });
      return;
    }
    const duplicateMembership = members.find((member) => claimedMembers.has(`${member.pageIndex}:${member.regionId}`));
    if (duplicateMembership) {
      issues.push({
        code: 'cross-page.multiple-group-membership', candidateIndex,
        message: `跨页资产区域 ${duplicateMembership.regionId} 已属于另一个候选组`,
      });
      return;
    }
    if (candidate.captionPageIndex !== undefined
      && !members.some((member) => member.pageIndex === candidate.captionPageIndex)) {
      issues.push({
        code: 'cross-page.invalid-caption-owner', candidateIndex,
        message: '跨页资产标题页必须属于该组成员页面',
      });
      return;
    }
    const independentWeakEvidence = new Set(candidate.weakEvidence);
    if (!candidate.strongEvidence && independentWeakEvidence.size < 2) {
      issues.push({
        code: 'cross-page.insufficient-evidence', candidateIndex,
        message: '跨页资产缺少强证据或至少两项独立弱证据',
      });
      return;
    }
    const identity = [candidate.kind, ...members.map((member) => `${member.pageIndex}:${member.regionId}:${member.role}`)]
      .join('|');
    groups.push({
      ...candidate,
      members,
      weakEvidence: [...independentWeakEvidence].sort(),
      provenance: [...candidate.provenance],
      id: `cross-page-${candidate.kind}-${stableHash(identity)}`,
      status: 'validated',
    });
    members.forEach((member) => claimedMembers.set(`${member.pageIndex}:${member.regionId}`, candidateIndex));
  });
  return { groups, issues };
}
