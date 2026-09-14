import katex from 'katex';

function exportPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('公式 PNG 编码失败'));
    }, 'image/png');
  });
}

function loadSvg(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('公式 MathML 渲染失败'));
    // Chromium treats an SVG foreignObject loaded from a blob: URL as an
    // opaque-origin resource and taints the destination canvas. An encoded
    // data URL keeps this self-contained SVG origin-clean, so it can safely be
    // exported as the immutable PNG asset used by Typst.
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

export async function renderLatexFormulaPng(latex: string, scale = 4): Promise<Blob> {
  const mathml = katex.renderToString(latex, {
    displayMode: true,
    output: 'mathml',
    throwOnError: true,
    strict: 'error',
    trust: false,
  });
  const host = document.createElement('div');
  host.style.cssText = [
    'position:fixed', 'left:-10000px', 'top:0', 'display:inline-block',
    'background:white', 'color:black', 'font-size:28px',
    'font-family:"Cambria Math","STIX Two Math","DejaVu Serif",serif',
    'padding:8px 12px', 'line-height:1.35', 'white-space:nowrap',
  ].join(';');
  host.innerHTML = mathml;
  document.body.append(host);
  try {
    await document.fonts?.ready;
    const bounds = host.getBoundingClientRect();
    const width = Math.max(24, Math.ceil(bounds.width));
    const height = Math.max(24, Math.ceil(bounds.height));
    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
      `<foreignObject width="${width}" height="${height}">`,
      '<div xmlns="http://www.w3.org/1999/xhtml" style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:white;color:black;font-size:28px;font-family:Cambria Math,STIX Two Math,DejaVu Serif,serif;line-height:1.35;white-space:nowrap">',
      mathml,
      '</div></foreignObject></svg>',
    ].join('');
    const image = await loadSvg(svg);
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('公式画布初始化失败');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return exportPng(canvas);
  } finally {
    host.remove();
  }
}
