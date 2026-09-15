import type { ImmutableAsset } from './types';

export async function hashBlob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyAssetHash(asset: ImmutableAsset): Promise<boolean> {
  return (await hashBlob(asset.blob)) === asset.sha256;
}
