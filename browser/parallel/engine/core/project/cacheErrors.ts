export class CachePersistenceError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'CachePersistenceError';
    this.cause = cause;
  }
}

export async function persistCacheRecord(
  label: string,
  operation: (() => Promise<void>) | undefined,
): Promise<void> {
  if (!operation) return;
  try {
    await operation();
  } catch (error) {
    throw new CachePersistenceError(`${label}写入失败；为避免重复 API 请求，任务已停止`, error);
  }
}
