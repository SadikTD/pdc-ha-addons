// Fetch for the public web (WordPress, source pages, images) through curl. The sites'
// Cloudflare blocks Node's own TLS handshake (403 on WGTC, TMS and AOTF, tested 2026-11-23)
// but lets curl through, so curl is used where it's installed (the add-on image has it).
// Returns a standard Response, so callers and tests treat it like fetch.
import { execFile } from 'node:child_process';

let hasCurl = null;
const probe = () => new Promise(r => execFile('curl', ['--version'], { timeout: 5000 }, e => r(!e)));

export async function webFetch(url, init = {}) {
  if (hasCurl === null) hasCurl = await probe();
  if (!hasCurl) return fetch(url, init);
  const args = ['-sS', '-L', '--compressed', '--max-redirs', '5', '--max-time', '30', '-o', '-', '-w', '%{stderr}\n@@%{url_effective} %{http_code} %{content_type}'];
  for (const [k, v] of Object.entries(init.headers || {})) args.push('-H', `${k}: ${v}`);
  args.push('--', String(url));
  return new Promise((resolve, reject) => {
    execFile('curl', args, { encoding: 'buffer', maxBuffer: 12 * 1024 * 1024, timeout: 35000 }, (err, stdout, stderr) => {
      const m = /@@(\S+) (\d{3}) ?(.*)$/.exec(String(stderr).trim());
      if (!m || m[2] === '000') return reject(new Error(err ? `network error (${String(stderr).split('\n')[0].slice(0, 120)})` : 'network error'));
      // A 204/304 can't carry a body in a Response. x-final-url: where redirects ended (short links).
      const status = Number(m[2]);
      resolve(new Response([204, 304].includes(status) ? null : stdout, { status, headers: { 'x-final-url': m[1], ...(m[3] ? { 'content-type': m[3] } : {}) } }));
    });
  });
}
