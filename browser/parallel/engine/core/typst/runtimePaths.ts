export interface TypstRuntimePaths {
  compilerWasm: string;
  rendererWasm: string;
  fontFiles: string[];
}

export function getTypstRuntimePaths(baseUrl: string, documentBaseUrl?: string): TypstRuntimePaths {
  const trimmed = baseUrl.replace(/^\/+|\/+$/g, '');
  const base = baseUrl === './' ? './' : trimmed ? `/${trimmed}/` : '/';
  const resolve = (path: string): string => documentBaseUrl
    ? new URL(path, new URL(base, documentBaseUrl)).href
    : `${base}${path}`;
  return {
    compilerWasm: resolve('vendor/typst/typst_ts_web_compiler_bg.wasm'),
    rendererWasm: resolve('vendor/typst/typst_ts_renderer_bg.wasm'),
    fontFiles: [
      resolve('vendor/typst/noto-serif-sc-400.ttf'),
      resolve('vendor/typst/dejavu-math-tex-gyre.ttf'),
    ],
  };
}
