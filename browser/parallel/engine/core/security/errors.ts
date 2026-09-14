export function safeErrorMessage(error: unknown, maxLength = 300): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/(Authorization\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi, '$1[redacted]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .slice(0, maxLength);
}
