export type CompositionIssueCode =
  | 'asset-hash-mismatch'
  | 'asset-missing'
  | 'asset-unexpected'
  | 'layout-region-order'
  | 'marker-missing'
  | 'marker-unexpected'
  | 'pdf-invalid'
  | 'preview-empty';

export interface CompositionGateIssue {
  code: CompositionIssueCode;
  id: string;
  message: string;
}

export interface CompositionGateInput {
  pdfHeader: string;
  preview: string;
  sourceAssetHashes: Record<string, string>;
  targetAssetHashes: Record<string, string>;
  requiredMarkerIds: readonly string[];
  emittedMarkerIds: readonly string[];
  layoutRegionOrder: readonly string[];
  emittedRegionOrder: readonly string[];
}

export interface CompositionGateResult {
  pass: boolean;
  issues: CompositionGateIssue[];
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function runCompositionGate(input: CompositionGateInput): CompositionGateResult {
  const issues: CompositionGateIssue[] = [];
  if (!input.pdfHeader.startsWith('%PDF-')) {
    issues.push({ code: 'pdf-invalid', id: 'pdf', message: '编译产物不是有效 PDF' });
  }
  if (!input.preview.trim()) {
    issues.push({ code: 'preview-empty', id: 'preview', message: '中文预览为空' });
  }

  for (const [id, hash] of Object.entries(input.sourceAssetHashes)) {
    const target = input.targetAssetHashes[id];
    if (target === undefined) {
      issues.push({ code: 'asset-missing', id, message: `缺少不可变资产 ${id}` });
    } else if (target !== hash) {
      issues.push({ code: 'asset-hash-mismatch', id, message: `不可变资产 ${id} 的哈希发生变化` });
    }
  }
  for (const id of Object.keys(input.targetAssetHashes)) {
    if (!(id in input.sourceAssetHashes)) {
      issues.push({ code: 'asset-unexpected', id, message: `出现未声明资产 ${id}` });
    }
  }

  const emittedMarkers = new Set(input.emittedMarkerIds);
  const requiredMarkers = new Set(input.requiredMarkerIds);
  for (const id of input.requiredMarkerIds) {
    if (!emittedMarkers.has(id)) issues.push({ code: 'marker-missing', id, message: `缺少定位标记 ${id}` });
  }
  for (const id of input.emittedMarkerIds) {
    if (!requiredMarkers.has(id)) issues.push({ code: 'marker-unexpected', id, message: `出现未声明定位标记 ${id}` });
  }
  if (!sameOrder(input.layoutRegionOrder, input.emittedRegionOrder)) {
    issues.push({ code: 'layout-region-order', id: 'regions', message: '输出区域顺序与源论文不一致' });
  }

  issues.sort((left, right) => left.code.localeCompare(right.code) || left.id.localeCompare(right.id));
  return { pass: issues.length === 0, issues };
}
