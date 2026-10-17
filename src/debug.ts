// Con ?debug en la URL muestra en pantalla los mensajes y errores del navegador.
// Sirve para ver en el móvil por qué falla algo, sin consola.
if (new URLSearchParams(location.search).has('debug')) {
  const box = document.createElement('pre');
  box.style.cssText =
    'position:fixed;top:0;left:0;right:0;max-height:45vh;overflow:hidden;margin:0;padding:6px 8px;' +
    'background:rgba(0,0,0,.82);color:#9fe39f;font:10px/1.35 ui-monospace,monospace;white-space:pre-wrap;' +
    'word-break:break-all;z-index:99;pointer-events:none';
  const lines: string[] = [];
  const add = (kind: string, args: unknown[]) => {
    const text = args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : String(a))).join(' ');
    lines.push(`[${kind}] ${text.slice(0, 400)}`);
    if (lines.length > 14) lines.shift();
    box.textContent = lines.join('\n');
  };
  for (const kind of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[kind].bind(console);
    console[kind] = (...args: unknown[]) => {
      add(kind, args);
      original(...args);
    };
  }
  window.addEventListener('error', (e) => add('error', [e.message, `${e.filename}:${e.lineno}`]));
  window.addEventListener('unhandledrejection', (e) => add('promesa', [e.reason]));
  document.addEventListener('DOMContentLoaded', () => document.body.append(box));
}
