import fs from 'node:fs';
import path from 'node:path';
import { repoDir, search } from './bank.mjs';
import { loadSynonyms } from './synonyms.mjs';
import { tokenize } from './core.mjs';

const dir = repoDir(process.env.BANK_SLUG || 'e-2');
const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
const N = idx.docs.length;
const short = (p) => String(p).split(/[\\/]/).pop();

const q = process.argv[2] || '定时 任务 投递 会话';
const qt = [...new Set(tokenize(q))];
console.log(`查询「${q}」\ntokenize → [${qt.join(', ')}]  共 ${qt.length} 个\n`);

const df = new Map();
for (const d of idx.docs) for (const t of new Set(d.tokens || [])) df.set(t, (df.get(t) || 0) + 1);
const idf = (t) => Math.log(1 + N / (df.get(t) || 1));

console.log('=== 各 token ===');
for (const t of qt) console.log(`  ${t.padEnd(5)} df=${String(df.get(t) || 0).padStart(4)} idf=${idf(t).toFixed(2)}`);

// 别名/同义词扩展词
const qlow = q.toLowerCase();
const extSet = new Set();
for (const g of [...loadSynonyms(dir)]) if (g.some((w) => w && qlow.includes(w))) for (const w of g) for (const t of tokenize(w)) extSet.add(t);

console.log('\n=== top-8 明细（含覆盖率）===');
const hits = search(dir, q, 8);
for (const [i, h] of hits.entries()) {
  const d = idx.docs.find((x) => x.id === h.id) || {};
  const toks = new Set(d.tokens || []);
  const matched = qt.filter((t) => toks.has(t));
  const extMatched = [...extSet].filter((t) => toks.has(t) && !qt.includes(t));
  const cover = matched.length / qt.length;
  const len = (d.tokens || []).length;
  console.log(`${i + 1}. ${h.score.toFixed(2)}  ${short(h.page).padEnd(16)} 覆盖 ${matched.length}/${qt.length}=${cover.toFixed(2)}  len=${len}`);
  console.log(`     命中[${matched.join(',')}]${extMatched.length ? '  扩展[' + extMatched.slice(0, 8).join(',') + ']' : ''}`);
  console.log(`     ${String(d.title || '').slice(0, 55)}`);
}

console.log('\n=== 期望页 todos.md 的最好成绩 ===');
const th = hits.find((h) => short(h.page) === 'todos.md');
console.log(th ? `  第 ${hits.indexOf(th) + 1} 名，${th.score.toFixed(2)}` : '  不在 top-8');
