// Build : copie les fichiers statiques dans dist/ et minifie JS/CSS inline des pages HTML.
// Les sources restent lisibles ; en cas d'échec de minification d'un bloc, l'original est conservé.
import { transform } from 'esbuild';
import { readdir, readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = 'dist';
const SKIP = new Set(['.git', 'node_modules', 'dist', 'package.json', 'package-lock.json', 'build.mjs', 'vercel.json', 'tests-caisse', 'tests-compta', 'tools', 'docs', 'supabase', 'data']);
const SKIP_EXT = /\.(sql|ts|md)$|^index \(\d+\)\.html$/;

async function minHtml(html) {
  const jobs = [];
  html = html.replace(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g, (m, attrs = '', body) => {
    if (/\bsrc=/.test(attrs) || !body.trim() || /type\s*=\s*["'](?!text\/javascript|module)/.test(attrs)) return m;
    const i = jobs.push(transform(body, { minify: true, legalComments: 'none', target: 'es2020' })
      .then(r => `<script${attrs}>${r.code}</script>`, e => (console.warn('script conservé:', e.message.split('\n')[0]), m))) - 1;
    return `\u0000J${i}\u0000`;
  });
  html = html.replace(/<style(\s[^>]*)?>([\s\S]*?)<\/style>/g, (m, attrs = '', body) => {
    const i = jobs.push(transform(body, { loader: 'css', minify: true, legalComments: 'none' })
      .then(r => `<style${attrs}>${r.code}</style>`, () => m)) - 1;
    return `\u0000J${i}\u0000`;
  });
  const res = await Promise.all(jobs);
  return html.replace(/\u0000J(\d+)\u0000/g, (_, i) => res[i]).replace(/<!--(?!\[if)[\s\S]*?-->/g, '');
}

async function walk(dir, rel = '') {
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    if (!rel && SKIP.has(e.name)) continue;
    const r = join(rel, e.name);
    if (e.isDirectory()) { await mkdir(join(OUT, r), { recursive: true }); await walk(dir, r); continue; }
    if (SKIP_EXT.test(e.name)) continue;
    if (e.name.endsWith('.html')) {
      const src = await readFile(r, 'utf8');
      const out = await minHtml(src);
      await writeFile(join(OUT, r), out);
      console.log(r, src.length, '->', out.length);
    } else await cp(r, join(OUT, r));
  }
}
await mkdir(OUT, { recursive: true });
await walk('.');
