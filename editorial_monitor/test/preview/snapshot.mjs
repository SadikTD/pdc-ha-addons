// Writes demo.js (a frozen copy of the running preview server's API) and preview.html, so the
// design gates can render the dashboard from a file. node test/preview/snapshot.mjs [base url]
import { writeFileSync } from 'node:fs';
const base = process.argv[2] || 'http://localhost:8123';
const paths = ['/api/state', '/api/checks', '/api/writers', '/api/rules', '/api/messages', '/api/events', '/api/settings', '/api/check/1'];
const data = {};
for (const p of paths) data[p] = await (await fetch(base + p)).json();
writeFileSync(new URL('./demo.js', import.meta.url), `window.DEMO = { data: ${JSON.stringify(data)},
  api(path) { const p = path.split('?')[0]; const d = this.data[p] || (p.startsWith('/api/check/') ? this.data['/api/check/1'] : null);
    return d ? Promise.resolve(JSON.parse(JSON.stringify(d))) : Promise.resolve({ ok: true, changed: [], failed: [] }); } };\n`);
writeFileSync(new URL('./preview.html', import.meta.url), (await (await fetch(base + '/')).text())
  .replace('href="app.css"', 'href="../../www/app.css"').replace('href="icon.svg"', 'href="../../www/icon.svg"').replace('<script src="app.js"></script>', '<script src="demo.js"></script>\n  <script src="../../www/app.js"></script>'));
console.log('wrote demo.js and preview.html');
