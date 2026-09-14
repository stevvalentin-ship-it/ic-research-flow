export interface DestroyablePdfDocument {
  destroy(): Promise<unknown> | unknown;
}

type CleanupDeferrer = (cleanup: () => void) => void;

function deferUntilPageUnload(cleanup: () => void): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('pagehide', cleanup, { once: true });
}

export function releasePdfDocument(
  document: DestroyablePdfDocument,
  defer: CleanupDeferrer = deferUntilPageUnload,
): void {
  defer(() => {
    try {
      void Promise.resolve(document.destroy()).catch(() => undefined);
    } catch {
      // Page teardown must never overwrite an already completed quality result.
    }
  });
}
