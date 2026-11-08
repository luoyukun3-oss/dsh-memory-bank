#!/usr/bin/env node
/**
 * bill.mjs —— 一条用量记录 → 倍率 & 高峰价（按 DeepSeek 官方价核算）
 * 单价来源 https://api-docs.deepseek.com/zh-cn/quick_start/pricing（2026-10-13 抓取；官方调价后改 PRICES）
 * 空闲价 = 高峰价一半；高峰 = 周一~周五 9:00-12:00、14:00-18:00（⚠️ 本脚本不识别法定节假日）
 * 用法：
 *   node bill.mjs 记录.txt          ← 把平台「详情」整段贴进 txt；也支持管道 type x.txt | node bill.mjs
 *   node bill.mjs --in 2753 --cache 119296 --out 9129 --fee 0.041654 --time "2026-10-13 19:00:01"
 *   node bill.mjs --text "输入 Token: 2,753 缓存读取: 119,296 输出 Token: 9,129 总费用: ¥0.041654"
 * 可选：--model pro ｜ --force-peak / --force-offpeak（核对平台有没有按错档计费）｜ --hourly
 */
import fs from 'node:fs';

// 元 / 百万 tokens，[空闲, 高峰]
const PRICES = {
  flash: { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  pro:   { hit: [0.15, 0.30], miss: [4.5, 9.0], out: [13.5, 27.0] },
};
const MODEL_LABEL = { flash: 'DeepSeek-V4.1-Flash', pro: 'DeepSeek-V4-Pro-0813' };

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n) => argv.includes('--' + n);

// ---------- 取输入 ----------
let raw = '';
if (argOf('text')) raw = argOf('text');
else {
  const fileArg = argOf('file') ?? argv.find((a) => !a.startsWith('--') && fs.existsSync(a));
  if (fileArg) raw = fs.readFileSync(fileArg, 'utf8');
  else if (!process.stdin.isTTY) raw = fs.readFileSync(0, 'utf8');
}

const toNum = (s) => (s === undefined ? undefined : Number(String(s).replace(/[,\s]/g, '')));
const grab = (re) => { const m = raw.match(re); return m ? m[1] : undefined; };
const money = (n) => '¥' + (Math.round(n * 1e8) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');

// ---------- 拼记录 ----------
const model = (argOf('model') ?? (/pro/i.test(grab(/模型组\s*[:：]\s*([^\n]+)/) ?? '') ? 'pro' : 'flash')).toLowerCase();
const rec = {
  miss: toNum(argOf('in') ?? grab(/输入\s*tokens?\s*[:：]\s*([\d,]+)/i)),
  hit: toNum(argOf('cache') ?? grab(/缓存读取\s*[:：]\s*([\d,]+)/)),
  out: toNum(argOf('out') ?? grab(/输出\s*tokens?\s*[:：]\s*([\d,]+)/i)),
  fee: toNum(argOf('fee') ?? grab(/总费用\s*[:：]\s*[¥￥]?\s*([\d.]+)/)),
  time: argOf('time') ?? grab(/时间\s*[:：]\s*(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)/),
  tps: toNum(argOf('tps') ?? grab(/吞吐\s*[:：]\s*([\d.]+)/)),
};

if (!PRICES[model]) { console.error(`未知模型 "${model}"（可用 flash / pro）`); process.exit(2); }
if (rec.miss === undefined && rec.hit === undefined && rec.out === undefined) {
  console.error('没解析到 token 数据。给参数（--in/--cache/--out/--fee/--time）或贴平台详情文本。');
  process.exit(2);
}
rec.miss ??= 0; rec.hit ??= 0; rec.out ??= 0;

// ---------- 判时段 ----------
const peakByRule = (d) => {
  const wd = d.getDay();
  if (wd === 0 || wd === 6) return false;
  const m = d.getHours() * 60 + d.getMinutes();
  return (m >= 9 * 60 && m < 12 * 60) || (m >= 14 * 60 && m < 18 * 60);
};
let when, peak, timeNote;
if (rec.time) {
  const d = new Date(rec.time.replace(' ', 'T'));
  when = `${rec.time}（周${'日一二三四五六'[d.getDay()]}）`;
  peak = peakByRule(d);
  timeNote = peak ? '高峰时段' : '空闲时段';
} else {
  when = '未提供时间 → 按当前时刻';
  peak = peakByRule(new Date());
  timeNote = (peak ? '高峰时段' : '空闲时段') + '（推断）';
}
if (has('force-peak')) { peak = true; timeNote = '强制按高峰档'; }
if (has('force-offpeak')) { peak = false; timeNote = '强制按空闲档'; }

// ---------- 算钱 ----------
const p = PRICES[model];
const idx = peak ? 1 : 0;
// 用「整数微元」算钱：单价 ×100 必为整数 ⇒ tokens × 单价 ×100 是精确整数（单位 1e-8 元），全程无浮点误差。
// （这是复核 agent 的建议：直接 tokens×单价 = 微元数，避免 0.002753+0.00238592 这类浮点求和误差。）
const c8 = (tokens, price) => tokens * Math.round(price * 100);
const sum8 = (i) => c8(rec.miss, p.miss[i]) + c8(rec.hit, p.hit[i]) + c8(rec.out, p.out[i]);
const cMiss = c8(rec.miss, p.miss[idx]) / 1e8;
const cHit = c8(rec.hit, p.hit[idx]) / 1e8;
const cOut = c8(rec.out, p.out[idx]) / 1e8;
const official = sum8(idx) / 1e8;
const officialOther = sum8(1 - idx) / 1e8;

const n = (x) => x.toLocaleString('en-US');
const L = [];
L.push(`【计费核算】${MODEL_LABEL[model]}（${model} 价目）`);
L.push(`· 时间：${when} → ${timeNote}`);
L.push(`· 单价档：缓存命中 ${money(p.hit[idx])}/M ｜ 未命中 ${money(p.miss[idx])}/M ｜ 输出 ${money(p.out[idx])}/M`);
L.push(`· 输入·未命中　${n(rec.miss).padStart(9)} tok × ${money(p.miss[idx])}/M = ${money(cMiss)}`);
L.push(`· 输入·缓存命中 ${n(rec.hit).padStart(9)} tok × ${money(p.hit[idx])}/M = ${money(cHit)}`);
L.push(`· 输出　　　　${n(rec.out).padStart(9)} tok × ${money(p.out[idx])}/M = ${money(cOut)}`);
L.push(`· 官方应扣（${peak ? '高峰' : '空闲'}）＝ ${money(official)}`);
if (rec.fee !== undefined) {
  const r = rec.fee / official;
  const other = rec.fee / officialOther;
  L.push(`· 平台实扣　　＝ ${money(rec.fee)}`);
  L.push(`· ⇒ 倍率：${r.toFixed(3)}×（实扣 ÷ 按「当时时段官方价」算出的应扣）`);
  // ⚠️ 结构性二义：官方「空闲价 = 高峰价一半」⇒ 同一笔金额必然对应两个相差 2 倍的倍率数字，
  //    单条记录**无法**判断平台按哪个基准标注；要区分得再给一条落在另一时段的记录。
  L.push(`　　⚠️ 别被另一套基准绕晕：以${peak ? '空闲' : '高峰'}价为基准 ＝ ${other.toFixed(3)}×（与上行相差恰好 2 倍 —— 官方「空闲价 = 高峰价一半」）⇒ 同一笔钱有两个倍率数字，**单条记录分不清平台按哪种标**，要区分得再给一条落在${peak ? '空闲' : '高峰'}时段的记录`);
  // 取整规则判别（全整数比较，无浮点风险）：平台是截断还是四舍五入？
  const fee8 = Math.round(rec.fee * 1e8);
  const floor8 = Math.floor(sum8(idx) / 100) * 100;
  const round8 = Math.round(sum8(idx) / 100) * 100;
  const hitF = fee8 === floor8, hitR = fee8 === round8;
  L.push(`· 取整规则：向下截断 ${money(floor8 / 1e8)} ${hitF ? '✅' : '✗'} ｜ 四舍五入 ${money(round8 / 1e8)} ${hitR ? '✅' : '✗'} ⇒ ${hitF && !hitR ? '平台是**向下截断**（少收零头，不是加价）' : hitR && !hitF ? '平台是**四舍五入**' : hitF && hitR ? '两种都能对上（位数不足，分不清）' : '**两种都对不上** ⇒ 口径可能不只是「官方价 × 单一倍率」，值得人工核'}`);
  const gap = rec.fee - official;
  L.push(`· 相对官方${peak ? '高峰' : '空闲'}价：${gap >= 0 ? '多收' : '少收'} ${money(Math.abs(gap))}`);
} else {
  L.push('· 没给实扣金额 ⇒ 只算官方价（要倍率请加 --fee 或贴「总费用」）');
}
const total = rec.miss + rec.hit + rec.out;
L.push(`· 若这笔发生在${peak ? '空闲' : '高峰'}时段：${money(officialOther)}（${(officialOther / official).toFixed(2)} 倍）`);
L.push(`· 成本结构：输出占 ${((cOut / official) * 100).toFixed(1)}% ｜ 输入(未命中) ${((cMiss / official) * 100).toFixed(1)}% ｜ 缓存 ${((cHit / official) * 100).toFixed(1)}%`);
if (rec.hit > 0) {
  const ifMiss = (rec.hit / 1e6) * p.miss[idx];
  L.push(`· 缓存收益：${n(rec.hit)} 缓存 tok 只花 ${money(cHit)}；若按未命中价要 ${money(ifMiss)} ⇒ 省下 ${money(ifMiss - cHit)}（${(((ifMiss - cHit) / ifMiss) * 100).toFixed(1)}%）`);
}
if (has('hourly') && rec.tps) {
  L.push(`· 吞吐 ${rec.tps} tok/s ⇒ 满速跑 1 小时约输出 ${n(Math.round(rec.tps * 3600))} tok ≈ ${money((rec.tps * 3600 / 1e6) * p.out[idx])}（只算输出，${peak ? '高峰' : '空闲'}价）`);
}
L.push(`· 合计 tokens：${n(total)}（输入 ${n(rec.miss + rec.hit)} + 输出 ${n(rec.out)}）`);

console.log(L.join('\n'));
