import './styles.css';
import './core.js';
import './math-config.js';
import './math.js';
import { installBrowserRuntime } from './runtime.js';

try {
  await installBrowserRuntime(globalThis.ICRF);
  await import('./reader.js');
  await import('./research.js');
  await import('./app.js');
  await globalThis.ICRF.start();
} catch(error) {
  document.body.innerHTML='<main class="startup-error"><h1>浏览器工作空间未能打开</h1><p></p><p>请允许本站使用浏览器存储，并通过网站地址访问。</p><button>重新载入</button></main>';
  document.querySelector('p').textContent=error.message;
  document.querySelector('button').onclick=()=>location.reload();
}
