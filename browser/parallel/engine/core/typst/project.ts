import type { ImmutableAsset } from '../assets/types';
import { verifyAssetHash } from '../assets/hash';
import type { LayoutRegion, SemanticUnitKind } from '../../types/models';
import type { CrossPageAssetGroup } from '../vision/crossPageRelations';
import { escapeTypstString, escapeTypstText } from './escape';
import {
  buildAcademicTemplate,
  type AcademicTemplateOptions,
  type TargetLayoutPolicy,
} from './template';

export interface TypstTargetSegment {
  id: string;
  text: string;
}

export interface TypstSemanticUnit {
  id: string;
  kind: SemanticUnitKind;
  layoutRegionId: string;
  order: number;
  text?: string;
  headingLevel?: 1 | 2 | 3;
  headingNumber?: string;
  targetSegments?: TypstTargetSegment[];
  assetId?: string;
  crossPageAssetGroupId?: string;
  sourceColumn?: 'left' | 'right' | 'span';
  flowGroupId?: string;
}

export interface TypstProjectInput {
  metadata: AcademicTemplateOptions;
  regions: readonly LayoutRegion[];
  units: readonly TypstSemanticUnit[];
  assets: readonly ImmutableAsset[];
  /** Keep the source regions, or reflow every translated text region as one readable column. */
  targetLayoutPolicy?: TargetLayoutPolicy;
  repairPlan?: LayoutRepairPlan;
  crossPageAssetGroups?: readonly CrossPageAssetGroup[];
}

export interface LayoutRepairAction {
  type: 'heading-spacing' | 'page-break' | 'asset-scale' | 'stack-assets';
  unitId: string;
  detail: string;
}

export interface LayoutRepairPlan {
  attempt: 1 | 2;
  extraHeadingBelowPt: Record<string, number>;
  forcePageBreakBeforeUnitIds: string[];
  assetScaleByUnitId: Record<string, number>;
  stackAssetGroupIds: string[];
  issueFingerprints: string[];
  actions: LayoutRepairAction[];
}

export interface TypstProject {
  mainContent: string;
  files: Map<string, Uint8Array>;
  markerIds: string[];
  regionIds: string[];
}

function quote(value: string): string {
  return `"${escapeTypstString(value)}"`;
}

function renderTextUnit(
  unit: TypstSemanticUnit,
  markerIds: string[],
  repairPlan?: LayoutRepairPlan,
): string {
  const rawSegments = unit.targetSegments?.length
    ? unit.targetSegments
    : [{ id: unit.id, text: unit.text ?? '' }];
  const frontLabel = unit.kind === 'abstract' ? '摘要' : unit.kind === 'keywords' ? '关键词' : undefined;
  const segments = rawSegments.map((segment, index) => ({
    ...segment,
    text: index === 0 && frontLabel
      ? segment.text.replace(/^(?:摘要|abstract|关键词|key\s*words?)\s*(?:[.:：—-]\s*)?/i, '')
      : segment.text,
  }));
  const withPageBreak = (content: string): string => (
    repairPlan?.forcePageBreakBeforeUnitIds.includes(unit.id)
      ? `#pagebreak(weak: true)\n${content}`
      : content
  );
  const marked = segments.map((segment, index) => {
    markerIds.push(segment.id);
    const prefix = index === 0 && unit.headingNumber ? `${escapeTypstText(unit.headingNumber)} ` : '';
    return `#pp-unit(${quote(encodeURIComponent(segment.id))})[${prefix}${escapeTypstText(segment.text)}]`;
  }).join('\n');
  if (unit.kind === 'title') return withPageBreak(`#pp-title[${marked}]`);
  if (unit.kind === 'author' || unit.kind === 'affiliation') return withPageBreak(`#pp-author[${marked}]`);
  if (unit.kind === 'heading') {
    const macro = (unit.headingLevel ?? 1) >= 2 ? 'pp-subheading' : 'pp-heading';
    const extra = Math.max(0, Math.min(4, repairPlan?.extraHeadingBelowPt[unit.id] ?? 0));
    const heading = `#${macro}(extra-below: ${extra}pt)[${marked}]`;
    return withPageBreak(heading);
  }
  if (unit.kind === 'abstract' || unit.kind === 'keywords') {
    return withPageBreak(`#pp-front-matter[${escapeTypstText(frontLabel!)}][${marked}]`);
  }
  if (unit.kind === 'caption' || unit.kind === 'table-title') return withPageBreak(`#pp-caption[${marked}]`);
  if (unit.kind === 'reference') return withPageBreak(`#pp-reference[${marked}]`);
  return withPageBreak(marked);
}

function assetExtension(asset: ImmutableAsset): string {
  return asset.mimeType === 'image/jpeg' ? 'jpg' : 'png';
}

function sourceWidth(width: number): string {
  if (!Number.isFinite(width) || width <= 0) throw new Error('Immutable asset width must be positive');
  return `${Math.round(width * 100) / 100}pt`;
}

function boundedAssetWidth(
  asset: ImmutableAsset,
  regionMode: LayoutRegion['mode'],
  metadata: AcademicTemplateOptions,
  rowSize = 1,
  targetLayoutPolicy: TargetLayoutPolicy = 'source-layout',
): number {
  const margin = metadata.margin ?? Math.max(36, metadata.paperWidth * 0.1);
  const contentWidth = metadata.paperWidth - margin * 2;
  const gutter = metadata.columnGap ?? 12;
  const regionAvailable = regionMode === 'double' && asset.widthMode !== 'span'
    ? (contentWidth - gutter) / 2
    : contentWidth;
  const available = rowSize > 1
    ? (contentWidth - gutter * (rowSize - 1)) / rowSize
    : regionAvailable;
  if (
    targetLayoutPolicy === 'single-column'
    && rowSize === 1
    && asset.widthMode === 'column'
    && asset.captionUnitId
    && (asset.kind === 'figure' || asset.kind === 'table' || asset.kind === 'code')
  ) {
    // Source-column assets otherwise remain only half a page wide after the
    // surrounding Chinese text is reflowed into one column.  Crops are made
    // at high resolution, so a moderate display enlargement improves label
    // readability without changing the immutable bytes.
    const readableFloor = contentWidth * (asset.kind === 'table' ? 0.9 : 0.78);
    return Math.min(contentWidth, Math.max(asset.sourceRect.w, readableFloor));
  }
  return Math.min(asset.sourceRect.w, available);
}

/**
 * Keep a source-side horizontal asset row only when every member remains
 * readable at its projected single-column width. Portrait galleries are the
 * deliberate exception: their images are narrow and are read as a set.
 */
export function shouldStackAssetRow(
  assets: readonly ImmutableAsset[],
  metadata: AcademicTemplateOptions,
  targetLayoutPolicy: TargetLayoutPolicy,
): boolean {
  if (assets.length <= 1) return false;
  // A shared caption can describe vertical panels; preserve that source order
  // even when the output keeps the original column layout.
  if (assets[0]?.captionUnitId && assets.every((asset) => (
    asset.captionUnitId === assets[0]!.captionUnitId && asset.sourcePage === assets[0]!.sourcePage
  )) && assets.some((asset, index) => assets.slice(index + 1).some((other) => (
    Math.min(asset.sourceRect.y + asset.sourceRect.h, other.sourceRect.y + other.sourceRect.h)
      <= Math.max(asset.sourceRect.y, other.sourceRect.y)
  )))) return true;
  if (targetLayoutPolicy !== 'single-column') return false;
  const margin = metadata.margin ?? Math.max(36, metadata.paperWidth * 0.1);
  const contentWidth = metadata.paperWidth - margin * 2;
  const gutter = metadata.columnGap ?? 12;
  const cellWidth = (contentWidth - gutter * (assets.length - 1)) / assets.length;
  const portraitGallery = assets.every((asset) => (
    asset.kind === 'figure'
    && !asset.captionUnitId
    && asset.sourceRect.h >= asset.sourceRect.w * 1.08
    && asset.sourceRect.w <= contentWidth * 0.25
  ));
  if (portraitGallery) return false;
  return assets.some((asset) => {
    const scale = cellWidth / asset.sourceRect.w;
    if (asset.kind === 'table' || asset.kind === 'code') {
      return cellWidth < contentWidth * 0.4 || scale < 0.82;
    }
    if (asset.kind === 'formula') return cellWidth < 120 || scale < 0.72;
    return cellWidth < 125 || scale < 0.6;
  });
}

export async function buildTypstProject(input: TypstProjectInput): Promise<TypstProject> {
  const targetLayoutPolicy = input.targetLayoutPolicy ?? 'source-layout';
  const unitsById = new Map(input.units.map((unit) => [unit.id, unit]));
  if (unitsById.size !== input.units.length) throw new Error('Duplicate semantic unit ID');
  const assetsById = new Map(input.assets.map((asset) => [asset.id, asset]));
  if (assetsById.size !== input.assets.length) throw new Error('Duplicate immutable asset ID');

  const markerIds: string[] = [];
  const repairPlan = input.repairPlan;
  const regionBodies: Array<{ mode: 'double' | 'root'; content: string; lastFlow?: string }> = [];
  const pushRegionBody = (mode: 'double' | 'root', content: string, firstFlow?: string, lastFlow?: string): void => {
    const previous = regionBodies.at(-1);
    if (mode === 'root' && previous?.mode === 'root' && firstFlow && previous.lastFlow === firstFlow) {
      previous.content += ` ${content}`;
      previous.lastFlow = lastFlow;
      return;
    }
    if (mode === 'double' && previous?.mode === 'double') {
      previous.content = `${previous.content}\n\n${content}`;
      return;
    }
    regionBodies.push({ mode, content, lastFlow });
  };
  for (const region of input.regions) {
    const regionMode: LayoutRegion['mode'] = targetLayoutPolicy === 'single-column'
      ? (region.presentation === 'horizontal' ? 'full-width' : 'single')
      : region.mode;
    const segments: Array<{
      mode: LayoutRegion['mode'];
      rendered: Array<{
        content: string;
        sourceColumn?: TypstSemanticUnit['sourceColumn'];
        forceColumnBreakBefore?: boolean;
        flowGroupId?: string;
      }>;
    }> = [];
    const spanCaptionIds = new Set(input.assets
      .filter((asset) => asset.widthMode === 'span' && asset.captionUnitId)
      .map((asset) => asset.captionUnitId!));
    const regionUnitIds = new Set(region.orderedUnitIds);
    const captionAssets = new Map<string, ImmutableAsset[]>();
    for (const asset of input.assets) {
      if (!asset.captionUnitId || !regionUnitIds.has(asset.id) || !regionUnitIds.has(asset.captionUnitId)) continue;
      const group = captionAssets.get(asset.captionUnitId) ?? [];
      group.push(asset);
      captionAssets.set(asset.captionUnitId, group);
    }
    const horizontalCellCount = region.presentation === 'horizontal'
      ? captionAssets.size + region.orderedUnitIds.filter((unitId) => {
        const unit = unitsById.get(unitId);
        const member = unit?.assetId ? assetsById.get(unit.assetId) : undefined;
        return Boolean(member && !member.captionUnitId);
      }).length
      : 1;
    const horizontalAssets = region.orderedUnitIds.flatMap((unitId) => {
      const unit = unitsById.get(unitId);
      const member = unit?.assetId ? assetsById.get(unit.assetId) : undefined;
      return member ? [member] : [];
    });
    const autoStackRegion = region.presentation === 'horizontal'
      && shouldStackAssetRow(horizontalAssets, input.metadata, targetLayoutPolicy);
    const consumed = new Set<string>();
    const pushRendered = (
      mode: LayoutRegion['mode'],
      content: string,
      sourceColumn?: TypstSemanticUnit['sourceColumn'],
      forceColumnBreakBefore = false,
      flowGroupId?: string,
    ) => {
      const current = segments.at(-1);
      const segment = current?.mode === mode
        ? current
        : (() => {
          const created = { mode, rendered: [] as Array<{
            content: string;
            sourceColumn?: TypstSemanticUnit['sourceColumn'];
            forceColumnBreakBefore?: boolean;
            flowGroupId?: string;
          }> };
          segments.push(created);
          return created;
        })();
      segment.rendered.push({ content, sourceColumn, forceColumnBreakBefore, flowGroupId });
    };
    const renderAsset = (
      unit: TypstSemanticUnit,
      asset: ImmutableAsset,
      rowSize = 1,
      effectiveMode: LayoutRegion['mode'] = regionMode,
      inline = false,
    ) => {
      markerIds.push(unit.id);
      const path = `/assets/${asset.id}.${assetExtension(asset)}`;
      const width = boundedAssetWidth(
        asset,
        effectiveMode,
        input.metadata,
        rowSize,
        targetLayoutPolicy,
      ) * Math.max(0.8, Math.min(1, repairPlan?.assetScaleByUnitId[unit.id] ?? 1));
      return inline
        ? `#pp-inline-asset(${quote(encodeURIComponent(unit.id))}, ${quote(path)}, ${sourceWidth(width)})`
        : `#pp-asset(${quote(encodeURIComponent(unit.id))}, ${quote(path)}, ${sourceWidth(width)}, span: ${asset.widthMode === 'span'})`;
    };

    for (const unitId of region.orderedUnitIds) {
      if (consumed.has(unitId)) continue;
      const unit = unitsById.get(unitId);
      if (!unit) throw new Error(`Layout region ${region.id} references missing unit ${unitId}`);
      if (unit.layoutRegionId !== region.id) throw new Error(`Unit ${unit.id} has a mismatched layout region`);
      const asset = unit.assetId ? assetsById.get(unit.assetId) : undefined;

      // These units are slices of one source paragraph. A block image between
      // every slice turns ordinary sentences into narrow, disconnected lines.
      const inlineParent = unit.id.match(/^(.*)-inline-/)?.[1];
      if (inlineParent && region.presentation !== 'horizontal') {
        const siblings: TypstSemanticUnit[] = [];
        for (const siblingId of region.orderedUnitIds.slice(region.orderedUnitIds.indexOf(unitId))) {
          const sibling = unitsById.get(siblingId);
          if (!sibling || !siblingId.startsWith(`${inlineParent}-inline-`)
            || !['paragraph', 'formula'].includes(sibling.kind)) break;
          siblings.push(sibling);
        }
        if (siblings.length > 1 && siblings.some((sibling) => sibling.kind === 'formula')) {
          const content = siblings.map((sibling) => {
            consumed.add(sibling.id);
            const image = sibling.assetId ? assetsById.get(sibling.assetId) : undefined;
            if (sibling.assetId && !image) throw new Error(`Missing inline asset ${sibling.assetId}`);
            return image ? renderAsset(sibling, image, 1, regionMode, true)
              : renderTextUnit(sibling, markerIds, repairPlan);
          }).join(' ');
          pushRendered(regionMode, content, unit.sourceColumn, false, unit.flowGroupId);
          continue;
        }
      }

      const captionId = asset?.captionUnitId ?? (captionAssets.has(unit.id) ? unit.id : undefined);
      const groupedAssets = captionId ? captionAssets.get(captionId) ?? [] : [];
      if (captionId && groupedAssets.length) {
        const caption = unitsById.get(captionId);
        if (!caption) throw new Error(`Immutable asset group references missing caption ${captionId}`);
        const assetUnits = groupedAssets.map((member) => {
          const memberUnit = unitsById.get(member.id);
          if (!memberUnit) throw new Error(`Immutable asset group references missing unit ${member.id}`);
          return { asset: member, unit: memberUnit };
        });
        const memberIds = [captionId, ...assetUnits.map((member) => member.unit.id)];
        memberIds.forEach((id) => consumed.add(id));
        const autoStackGroup = shouldStackAssetRow(
          assetUnits.map((member) => member.asset), input.metadata, targetLayoutPolicy,
        );
        const stackAssets = autoStackRegion || autoStackGroup || repairPlan?.stackAssetGroupIds.some((id) => (
          id === captionId || id === region.id
        ));
        const rowSize = stackAssets ? 1 : assetUnits.length > 1 ? assetUnits.length : horizontalCellCount;
        const groupMode: LayoutRegion['mode'] = regionMode === 'double'
          && (groupedAssets.length > 1 || groupedAssets.some((member) => member.widthMode === 'span'))
          ? 'full-width'
          : regionMode;
        const assetCodes = assetUnits.map((member) => (
          renderAsset(member.unit, member.asset, rowSize, groupMode)
        ));
        const assetsContent = assetCodes.length > 1 && !stackAssets
          ? `#grid(columns: ${assetCodes.length}, gutter: 6pt, ${assetCodes.map((code) => `[${code}]`).join(', ')})`
          : assetCodes.join('\n');
        const captionContent = renderTextUnit(caption, markerIds, repairPlan);
        const captionFirst = groupedAssets.every((member) => (
          member.kind === 'table' || member.kind === 'code'
        ));
        // Full-width immutable groups are emitted at the document root. Typst
        // can therefore move the complete unbreakable group only when the
        // remaining page space is insufficient; forcing a pagebreak here left
        // nearly empty pages before ordinary algorithms and figures.
        const forceGroupBreak = memberIds.some((id) => repairPlan?.forcePageBreakBeforeUnitIds.includes(id));
        const content = `${forceGroupBreak ? '#pagebreak(weak: true)\n' : ''}#pp-asset-group(column-flow: ${groupMode === 'double'})[\n${captionFirst ? `${captionContent}\n${assetsContent}` : `${assetsContent}\n${captionContent}`}\n]`;
        const columns = new Set(memberIds.map((id) => unitsById.get(id)?.sourceColumn).filter(Boolean));
        pushRendered(
          groupMode,
          content,
          columns.size === 1 ? [...columns][0] : 'span',
          false,
        );
        continue;
      }

      const unitMode = regionMode === 'double' && (asset?.widthMode === 'span' || spanCaptionIds.has(unit.id))
        ? 'full-width'
        : regionMode;
      if (unit.assetId) {
        if (!asset) throw new Error(`Unit ${unit.id} references missing asset ${unit.assetId}`);
        const assetContent = renderAsset(unit, asset, autoStackRegion ? 1 : horizontalCellCount, unitMode);
        pushRendered(
          unitMode,
          repairPlan?.forcePageBreakBeforeUnitIds.includes(unit.id)
            ? `#pagebreak(weak: true)\n${assetContent}`
            : assetContent,
          unit.sourceColumn,
          false,
        );
      } else {
        pushRendered(unitMode, renderTextUnit(unit, markerIds, repairPlan), unit.sourceColumn, false, unit.flowGroupId);
      }
    }
    if (region.presentation === 'horizontal') {
      const cells = segments.flatMap((segment) => segment.rendered.map((item) => (
        item.content.replace(/^#pagebreak\(weak: true\)\n/, '')
      )));
      if (cells.length) {
        // The band is an unbreakable root-level group, so natural pagination
        // preserves it without wasting the remainder of the previous page.
        const horizontalContent = autoStackRegion || repairPlan?.stackAssetGroupIds.includes(region.id)
          ? cells.join('\n')
          : `#grid(columns: ${cells.length}, gutter: 6pt, ${cells.map((cell) => `[${cell}]`).join(', ')})`;
        pushRegionBody('root', `#pp-asset-group[\n${horizontalContent}\n]`);
      }
      continue;
    }
    for (const segment of segments) {
      const rendered: string[] = [];
      let previousColumn: TypstSemanticUnit['sourceColumn'];
      let previousFlow: string | undefined;
      for (const item of segment.rendered) {
        if (segment.mode === 'double' && rendered.length > 0 && (
          item.forceColumnBreakBefore
          || (previousColumn === 'left' && item.sourceColumn === 'right')
        )) {
          rendered.push('#colbreak()');
        }
        if (item.flowGroupId && item.flowGroupId === previousFlow && rendered.length) {
          rendered[rendered.length - 1] += ` ${item.content}`;
        } else rendered.push(item.content);
        previousFlow = item.flowGroupId;
        if (item.sourceColumn && item.sourceColumn !== 'span') previousColumn = item.sourceColumn;
      }
      // Keep single/full-width flow at the document root. Wrapping a long
      // region in a breakable block makes nested unbreakable image groups
      // unaware of the real page boundary, so Typst can slice them at the
      // footer instead of moving the complete figure/table to the next page.
      // Two-column flow still requires its columns container.
      pushRegionBody(segment.mode === 'double' ? 'double' : 'root', rendered.join('\n\n'),
        segment.rendered[0]?.flowGroupId, segment.rendered.at(-1)?.flowGroupId);
    }
  }

  if (new Set(markerIds).size !== markerIds.length) throw new Error('Duplicate Typst marker ID');
  const mainContent = `${buildAcademicTemplate({
    ...input.metadata,
    targetLayoutPolicy,
  })}\n${regionBodies.map((body) => (
    body.mode === 'double' ? `#pp-double[\n${body.content}\n]` : body.content
  )).join('\n\n')}\n`;
  const files = new Map<string, Uint8Array>();
  const addFile = (path: string, bytes: Uint8Array): void => {
    if (files.has(path)) throw new Error(`Duplicate Typst project path: ${path}`);
    files.set(path, bytes);
  };

  for (const asset of input.assets) {
    if (!(await verifyAssetHash(asset))) throw new Error(`Immutable asset hash mismatch: ${asset.id}`);
    addFile(`/assets/${asset.id}.${assetExtension(asset)}`, new Uint8Array(await asset.blob.arrayBuffer()));
  }
  const encoder = new TextEncoder();
  addFile('/main.typ', encoder.encode(mainContent));
  addFile('/paper-parallel.json', encoder.encode(JSON.stringify({
    version: 1,
    markerIds,
    regionIds: input.regions.map((region) => region.id),
    assets: input.assets.map((asset) => ({
      id: asset.id,
      sha256: asset.sha256,
      crossPageAssetGroupId: asset.crossPageAssetGroupId,
    })),
    crossPageAssetGroups: (input.crossPageAssetGroups ?? []).map((group) => ({
      id: group.id,
      kind: group.kind,
      members: group.members,
      captionPageIndex: group.captionPageIndex,
      captionAnchor: group.captionAnchor,
      provenance: group.provenance,
    })),
  })));
  return {
    mainContent,
    files,
    markerIds,
    regionIds: input.regions.map((region) => region.id),
  };
}
