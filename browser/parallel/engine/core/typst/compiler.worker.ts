/// <reference lib="webworker" />
import { $typst } from '@myriaddreamin/typst.ts';
import { TypstSnippet } from '@myriaddreamin/typst.ts/contrib/snippet';
import type { TypstWorkerRequest, TypstWorkerResponse } from './messages';

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
let initialized = false;

function post(response: TypstWorkerResponse, transfer?: Transferable[]): void {
  workerScope.postMessage(response, transfer ?? []);
}

workerScope.onmessage = async (event: MessageEvent<TypstWorkerRequest>) => {
  const request = event.data;
  if (request.type !== 'compile') return;
  const progress = (phase: Extract<TypstWorkerResponse, { type: 'progress' }>['phase']): void => {
    post({ type: 'progress', requestId: request.requestId, phase });
  };

  try {
    progress('initializing');
    if (!initialized) {
      $typst.use(TypstSnippet.disableDefaultFontAssets());
      const fontData = await Promise.all(request.runtimePaths.fontFiles.map(async (fontUrl) => {
        const response = await fetch(fontUrl);
        if (!response.ok) throw new Error(`Unable to load local Typst font (${response.status})`);
        return new Uint8Array(await response.arrayBuffer());
      }));
      $typst.use(...fontData.map((font) => TypstSnippet.preloadFontData(font)));
      $typst.setCompilerInitOptions({ getModule: () => request.runtimePaths.compilerWasm });
      $typst.setRendererInitOptions({ getModule: () => request.runtimePaths.rendererWasm });
      initialized = true;
    }

    progress('mapping-files');
    await $typst.resetShadow();
    for (const file of request.files) await $typst.mapShadow(file.path, file.bytes);

    progress('compiling-pdf');
    const pdf = await $typst.pdf({ mainContent: request.mainContent });
    if (!pdf) throw new Error('Typst returned no PDF data');

    progress('rendering-preview');
    const svg = await $typst.svg({
      mainContent: request.mainContent,
      // The preview is a standalone SVG document, not inline HTML. The
      // renderer's optional interaction script contains raw && operators
      // that are invalid XML; a static preview needs only artwork and styles.
      data_selection: { body: true, defs: true, css: true, js: false },
    });
    const ownedPdf = new Uint8Array(pdf);
    post(
      { type: 'done', requestId: request.requestId, pdf: ownedPdf, svg },
      [ownedPdf.buffer],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    post({ type: 'error', requestId: request.requestId, message: message.slice(0, 500) });
  }
};
