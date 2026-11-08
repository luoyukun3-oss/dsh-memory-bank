// ============================================================================
// Memory Bank · test-fixture —— 给测试用的**夹具银行**（2026-11-08）
//
// 为什么要有它：`repos/` 是个人记忆数据，不进仓库（见 .gitignore）⇒ clone 下来的人
// 没有 `repos/e-2`，而 `test.mjs` 有 33 处断言依赖真实库（别名组、召回命中、i 值分布…）。
// 早年那些断言「跳过」处理过，但**跳过等于放弃覆盖** —— 正确做法是让测试自建一个带内容的库。
//
// 设计原则：
//   ① **内容自己编**，不抄个人记忆（夹具里不许出现任何真实偏好/路径/故障史）；
//   ② 但要**结构等价**：别名分组、表格行、条目级元数据、TOC、定时条目、归档页，一样不能少；
//   ③ 建完立即 reindex + 生成 TOC，让 `page-toc --check` 也全绿。
//
// ⚠️ 本文件只给测试用，不进运行链路（cli/bootstrap 都不 import 它）。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repoDir } from './core.mjs';
import { reindexPage, ITEM_PAGES } from './index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SLUG = '_test-fixture';

/** 夹具的各页内容。语义要能支撑 test.mjs 里的那些查询断言。 */
const PAGES = {
  'aliases.md': `# aliases（口语 ↔ 术语 别名表）

## 性能 / 卡顿
- 页面卡顿 | 卡顿 | 卡 | 很卡 | 慢 | 变慢 | 迟钝 | 发钝 | 卡死 | 一卡一卡 | 风扇一直响
- 渲染进程 CPU 高 | cpu 高 | 占用高 | 转得厉害 | 电脑很热
- 长脚本写文件 + 短命令调用 | 长命令走文件 | 一行调用 | 降低渲染开销 | 命令太长

## 网页 / 前端
- 按钮点了没反应 | 点了没反应 | 没有反应 | 点了没动静 | 搜索框没反应 | 按钮不工作
- SyntaxError | 脚本报错 | 整段不执行 | 页面空白 | 控制台报错

## 权限 / 沙箱
- 权限预设 defaultPreset | 权限 | 权限设置 | 权限改回 | 权限选项 | 改了权限
- 沙箱 | sandbox | 越界 | file access denied | 拒绝访问

## Python / 解释器
- 解释器 | python.exe | 用的哪个 Python | 环境 | venv | 虚拟环境
- range 只吃整数 | 循环次数 | 步长 | 小数 | TypeError

## 记忆 / 检索
- 召回 | recall | 搜不到 | 想不起来 | 记忆 | 老忘事 | 记不住
- 教训 | lessons | 踩坑 | 坑 | 错误模式
- 故障速查 | 出问题先查什么 | 症状 | 排查

## 工具 / 命令
- 行数预算 | 红线 | 超限 | budget
- 引号 | 反引号 | 转义 | 解析错误
- 编码 | 乱码 | UTF-8 | GBK | BOM

## 其它
- 待办 | todos | 清单 | 要做的事
- 决策 | decision | 拍板 | 定了
- 事件 | events | 干了什么 | 经过
- 程序记忆 | procedures | 招式 | 怎么做
- 备忘 | memo | 提醒 | 别忘
`,
  'faults.md': `# faults（故障速查）

## 故障备忘

| 症状 | 先查这里 | 结论 |
| --- | --- | --- |
| **页面卡顿 / 渲染进程 CPU 高** | 采样时模型有没有在输出 token | 多数是前端渲染长内容 <!-- i:5 s:probe c:high --> |
| **自己做的网页里，搜索框/按钮点了一点反应都没有** | F12 → Console 看有没有 SyntaxError | 顶层变量名撞 window 属性 <!-- i:5 s:user c:high --> |
| Python 里找不到刚装的库 | 先确认用的是哪个解释器 | 三个环境并存，别混用 <!-- i:5 s:user c:high --> |
| **跑 node 报 Access is denied** | permission.defaultPreset | workspace-write 拒外部 exe <!-- i:4 s:user c:high --> |
| 插件装了没生效 | profile 的 bundle 列表 | 刷新页面；宿主半边需重启 <!-- i:4 s:user c:high --> |
| **代理链路偶发超时** | 先测直连再测代理 | 中转层抖动，换线路即可 <!-- i:2 s:user c:mid --> |
| 会话日志解压只得到一行 | 是不是多帧 zstd | 必须逐帧解压 <!-- i:4 s:probe c:high --> |
| 注入里出现两套同名段 | 量配额时要匹配正文段标题（以「【」开头的那种） | 段目录不是正文 <!-- i:3 s:probe c:mid --> |
| 待办条目在注入里消失 | 是否缩进续行被当成独立条目 | 细节要用引用块藏 <!-- i:4 s:user c:high --> |
| 改了知识页但检索还是旧的 | 有没有跑 reindex | tick 不重建 index.json <!-- i:4 s:user c:high --> |
| 行数红线莫名变红 | 注释也算行数 | 超限先按域拆分 <!-- i:3 s:probe c:mid --> |

## 细节

- **卡顿的判据是「是否在出 token」**：静默期 renderer 占用很低，活动期高是渲染开销。
`,
  'decisions.md': `# decisions（决策与理由）

## 决策

- 2026-09-15 **权限预设改回 danger-full-access** —— 理由：workspace-write 下外部可执行文件一律被拒（node/python 都在工作区外），逐次审批会把流程打断。 <!-- i:4 s:user c:high -->
- 2026-09-20 **软遗忘只降权、物理文件永不删** —— 理由：历史必须可审计，删了就查不到当初为什么这么定。 <!-- i:5 s:user c:high -->
- 2026-10-01 **不做向量检索，先做别名表** —— 理由：别名表零成本当天可验收；向量要引模型，破坏零依赖。 <!-- i:4 s:user c:mid -->
`,
  'lessons.md': `# lessons（教训与规范）

## A. 语言基础

- **\`range()\` 只吃整数 —— 循环次数不能填小数**：\`range(1.5)\` 直接 TypeError；要小数步长得用循环累加。 <!-- i:4 s:user c:high -->
- **字符串不可变**：\`s[0] = 'X'\` 报 TypeError，只能重建新串。 <!-- i:3 s:user c:high -->

## B. 工具与环境

- **拿到统计数字先问「它是怎么算出来的」**：把上一轮跑过的数直接搬进新文档，中间数据变了而不自知。 <!-- i:5 s:user c:high -->
- **改参数前先 grep 调用链**：参数可能在某条分支里根本没用上，五分钟的阅读能省两轮标定。 <!-- i:4 s:probe c:high -->

## H. 自我复盘

- 2026-10-02 【把「没查到」当成「不存在」】找不到配置就推断"没在用"，实际是找错了键名。下次先确认查找路径对不对。 <!-- i:5 s:probe c:high -->
- 2026-10-05 【结论先证明再说话】凡出现判断（这是 bug／这样改就对），先跑一次能证伪的验证。 <!-- i:5 s:user c:high -->
`,
  'todos.md': `# todos

> 注入配额说明：**总预算 8000 字**，待办段单独 1200 字（这段数字要和 budgets/config-keys 一致）。
> ⚠️ 只有 \`- \` 开头的行会被提取进索引；细节用 \`> \` 引用块包起来就不会进注入。

## 进行中

- [ ] **做一件需要多步的事**：第一步先备份，第二步改代码，第三步跑测试。（这条故意写长一些，用来验证「注入只出目录、不出长正文」——正文续行会超过两百个字符，如果注入里出现了这段的后半截，就说明长正文被漏了进去。）
- [ ] 第二条待办：说明文字

## 其他待办

- [ ] 定时检查一遍工作区。 [21:00]
- [x] 一条已经完成的待办
`,
  'todos-archive.md': `# todos-archive（已完成归档）

- [x] 归档的旧待办：它不该出现在检索池里（归档＝遗忘）
`,
  'inbox.md': `# inbox（自动记录的待整理素材）

- 一条未提炼的候选素材：它不该冒充知识参与召回，只能被显式查看。
`,
  'environment.md': `# environment

- 工作区在本地磁盘；有三个 Python 环境并存，\`python\` 命令只指向其中一个。
- 编辑器与运行环境各自独立，装库后要先确认用的是哪个解释器。
`,
  'procedures.md': `# procedures（程序记忆·该怎么做）

- **改代码 / 改配置**：动手前先读源码，别从"观察到的行为"反推机制；改文件前先备份。
- **写脚本传中文参数**：走参数数组，别拼 shell 字符串（引号族会打架）。
`,
  'events.md': `# events（事件叙事）

- 2026-10-01 【搭好检索骨架】把分词、倒排索引、打分拉通，先跑通再优化。
`,
  'changelog.md': `# changelog（变更记录）

- 2026-10-01 初版：分词 + 索引 + 打分 + 召回。
`,
  'preferences.md': `# preferences

- 交流用简体中文，语气轻松；技术结论按事实走。
`,
  'memo.md': `# memo（备忘）

- 备忘一条：某个话题还没聊完，别忘了。
`,
  'notes.md': `# notes

- 随手记一条笔记：这条落在默认页。
`,
  'meta.md': `# meta

元页说明：本页是元信息，不该作为答案被召回，但显式问时应当给出。
`,
};

/**
 * 确保夹具银行存在并可用（幂等：已存在就直接 reindex 后返回）。
 * @returns {string} 夹具银行目录
 */
export function ensureFixtureBank() {
  const dir = repoDir(FIXTURE_SLUG);
  const pagesDir = path.join(dir, 'pages');
  fs.mkdirSync(pagesDir, { recursive: true });

  for (const [name, body] of Object.entries(PAGES)) {
    fs.writeFileSync(path.join(pagesDir, name), body, 'utf8');
  }

  // 索引：ITEM_PAGES 走条目级切分，其余整节
  for (const name of Object.keys(PAGES)) {
    try { reindexPage(dir, name); } catch { /* 单页失败不拖垮夹具 */ }
  }

  // 会话流水：`reflect` 的第一节「主题分布」是「用户消息 × 别名表」算出来的，
  // 所以夹具必须造一条流水，否则那一节永远是 0 个主题（2026-11-08 实测踩到）。
  // ⚠️ 日期必须**动态用今天**：`reflect(dir, {days:7})` 只看最近 7 天，
  //    写死一个固定日期的话，过一周夹具就"过期"、测试开始假红。
  // ⚠️ 内容自己编，只求能命中别名组；不许出现任何真实对话。
  const journalDir = path.join(dir, 'journal');
  fs.mkdirSync(journalDir, { recursive: true });
  const now = new Date();
  const ymd = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`;
  const ymdFile = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const journal = `# 会话流水（夹具）

## 会话 session-fixture-0000（本次处理 4 条记录）

- **[用户]** ${ymd} 10:00:00 页面卡顿得很厉害，风扇一直响，是不是渲染太慢了
- **[用户]** ${ymd} 10:05:00 循环次数不能填小数，range 报错了
- **[用户]** ${ymd} 10:10:00 上次改权限改成什么了，我想确认一下
- **[用户]** ${ymd} 10:15:00 这个网页按钮点了没反应，控制台也没报错
- **[助手·轮2]** 卡顿的判断要先看模型有没有在输出 token，静默期占用低属正常。
`;
  fs.writeFileSync(path.join(journalDir, `${ymdFile}.md`), journal, 'utf8');

  // 生成 TOC（让 `page-toc --check --all` 也全绿）
  const tocTool = path.join(HERE, '..', 'tools', 'page-toc.mjs');
  if (fs.existsSync(tocTool)) {
    spawnSync(process.execPath, [tocTool, '--repo', dir, '--all'], { encoding: 'utf8' });
  }
  // TOC 写完要重新索引一次（否则索引里还是没 TOC 的旧文本）
  for (const name of Object.keys(PAGES)) {
    try { reindexPage(dir, name); } catch {}
  }

  return dir;
}

/** 夹具 slug（测试里判断「用的是真库还是夹具」） */
export const FIXTURE = FIXTURE_SLUG;
