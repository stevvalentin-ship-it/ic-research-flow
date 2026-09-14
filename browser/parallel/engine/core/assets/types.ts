import type { Rect, WidthMode } from '../../types/models';

export type ImmutableAssetKind = 'figure' | 'table' | 'formula' | 'code' | 'page-furniture';
export type ImmutableAssetMimeType = 'image/png' | 'image/jpeg';

export interface ImmutableAsset {
  id: string;
  kind: ImmutableAssetKind;
  sourcePage: number;
  sourceRect: Rect;
  mimeType: ImmutableAssetMimeType;
  blob: Blob;
  sha256: string;
  widthMode: WidthMode;
  captionUnitId?: string;
  crossPageAssetGroupId?: string;
}

export interface AssetManifest {
  assets: ImmutableAsset[];
}
