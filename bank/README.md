# Memory Bank · 会学习、会遗忘的长期记忆系统

一个**零依赖**（纯 Node 标准库）、**按仓库隔离**、**可自动召回与自动保存**的 Agent 长期记忆系统。

给 AI 助手用的「记忆」不是把对话存下来就完了。这个项目回答四个具体问题：

| 问题 | 本项目的答案 |
|---|---|
| 下次怎么想起来？ | 关键词倒排索引 + **触发词联想**（cue）+ 关联边（rel），按提问自动召回 |
| 想起来的对不对？ | 每条带**来源/置信度/重要度**，软遗忘只降权**绝不物理删**，被取代的标 `sup:` |
| 记太多了会撑爆上下文吗？ | 开场注入**分 13 段 + 按段配额 + 总预算 8000 字**，只给索引，细节按需取 |
| 写错了怎么办？ | 纠错自动进候选箱、教训**哑弹审计**（零命中的退役候选）、做梦找未注意的关联 |

**零依赖**是硬约束：全部 import 都是 `node:` 内置或相对路径，没有 npm 依赖、没有编译步骤、没有向量模型。
（唯一非标准库是 `node:sqlite`——它是 Node 22.5+ **自带**的，不需要装任何东西。）

---

## 一、快速开始

```bash
# 1) 初始化当前目录的记忆银行（生成 repos/<slug>/ 骨架）
node <bank>/cli.mjs init

# 2) 记一条
node <bank>/cli.mjs remember "用户偏好用颜文字，少用 emoji" --page preferences.md

# 3) 查一条
node <bank>/cli.mjs recall "颜文字"
```

`init` 只建骨架（`bank.json` / `index.json` / 三个空目录）；`pages/` 下的知识页在第一次 `remember` 时**自动创建**，不用手搭。

**要挂到 DSH 上自动跑**（开场注入 + 提问召回 + 后台保存）见第八节。

### 目录长这样

```
_dsh_memory/
├─ bank/                  ← 本系统全部代码（76 个 .mjs，含 commands/ 与 hooks/ 子目录，零依赖）
│   ├─ README.md          ← 本文件（架构与用法）
│   └─ FORMAT.md          ← ★ 知识页**写入格式规范**（给替你写记忆的助手看）
├─ tools/                 ← 独立工具（19 个：审计、迁移、修复；个人专用脚本不入库）
└─ repos/<slug>/          ← 每个仓库一套银行（slug 由 cwd 推导，如 E:\2 → e-2）
   ├─ bank.json           元数据（会话数、上次摄入/反思时间）
   ├─ index.json          倒排索引（中文二元组 + 英文词，idf 打分）
   ├─ access.json         命中记录（复述效应 + 哑弹审计的数据源）
   ├─ cue.json            cue 触发词表
   ├─ state.json          增量摄入游标
   ├─ pages/*.md        ★ 知识页（可读、可手改、可被检索）
   ├─ journal/*.md        会话流水（从会话日志自动抽取）
   └─ reflections/*.md    深度反思（定时生成）
```

**仓库隔离**：`slug = cwd 规范化`，`E:\2` → `e-2`、`E:\python` → `e-python`，互不污染。
**全局层**：`repos/_global/pages/preferences.md` 存跨仓库偏好，每次召回都会带上。

---

## 二、架构

```
┌──────────────────── DSH 运行时（hook 桥接插件） ────────────────────┐
│  SessionStart     → hooks/session-start.mjs → 注入「开场摘要」13 段  │
│  UserPromptSubmit → hooks/user-prompt.mjs   → 按提问召回 + cue 联想  │
│                                        └→ 后台 spawn ingest（保存）  │
│  PreToolUse       → hooks/pre-tool.mjs      → 写文件前提醒行数预算   │
└─────────────────────────────────────────────────────────────────────┘
                                  ↓ 读写
                         repos/<slug>/pages/*.md + *.json
```

**为什么用 hook 而不是插件内直接读**：hook 是**双向**的（能读上下文、能注入），插件服务做不到注入；
但 hook 紧耦合（挂了会拖垮整轮提问），所以 hook 侧一切**写入必须自己吞异常**——召回是主力功能，
复述效应是锦上添花，锦上添花永远不该拖垮主力。

---

## 三、知识页（pages/）

| 页面 | 内容 | 进不进索引 |
|---|---|---|
| `preferences.md` | 用户画像与偏好 | ✅ |
| `environment.md` | 环境、工具、路径、端口 | ✅ |
| `todos.md` | 待办（索引式注入，每轮只看目录） | ✅ |
| `todos-archive.md` | 已完成待办归档 | ❌ 归档＝遗忘 |
| `faults.md` | 故障速查表（症状 → 先查什么） | ✅ 表格按行切分 |
| `lessons.md` | 教训与规范（最大的页，按节分组） | ✅ |
| `decisions.md` | 带理由的决策（**理由比结论重要**） | ✅ |
| `events.md` | 事件叙事（干了什么 + 为什么） | ✅ |
| `procedures.md` | 程序记忆（招式：该怎么做） | ✅ |
| `changelog.md` | 变更记录 | ✅ |
| `aliases.md` | 口语 ↔ 术语别名表 | ✅ 元页（显式问才给） |
| `inbox.md` | 未验证候选（**不进召回**，防污染） | ❌ |
| `handoff.md` | 跨会话交接快照（滚动覆盖） | ❌ 快照冒充知识只会污染检索 |
| `memo.md` | 备忘（给助手自己的提醒，带原话时间） | ✅ |

**条目级切分**：`events`/`decisions`/`lessons`/`todos`/`inbox`/`aliases`/`faults`/`procedures`
这些页是**一条一 doc**，不是一节一 doc——否则条目级元数据会在一节里互相覆盖、退化成节级。

**条目元数据**（行尾 HTML 注释，`parseMeta` 抽取、注入前剥掉）：

```markdown
- 某条教训内容 <!-- i:5 s:user c:high x:2026-12-31 sup:被新版取代 pin:1 t:标签 cue:触发词 rel:页:关键词:类型 -->
```

> ⚠️ **写之前先读 [FORMAT.md](FORMAT.md)** —— 那里有实测出来的边界：**写错格式不会让系统崩**
> （12 种坏格式试过，一次都没抛错），但会**静默失效**。最坑的一种是注释没闭合：
> 元数据全丢，而且那串 `<!-- i:5 -->` 会**留在正文里进索引、进注入**，白占预算。

| 字段 | 含义 |
|---|---|
| `i` | 重要度 1-5（打分时 `1+0.15*(i-3)`） |
| `s` | 来源：`user` / `probe`（实测）/ `infer`（推断） |
| `c` | 置信度：`low` 不进结果、`mid` ×0.85 |
| `x` | 到期日（过期 ×0.35，只降权不删） |
| `sup` | 被谁取代（×0.25，只降权不删） |
| `pin` | 引脚固定（豁免**时间性**衰减，不豁免「已被证明是错的」） |
| `t` | 主题标签（粗、可批量打） |
| `cue` | **触发词**：「看到这个词就想起我」（精、要挑词） |
| `rel` | 关联边：`rel:<页>:<关键词>:<类型>`，类型白名单 `causal/sequence/scenario/attribute/preference` |

---

## 四、命令参考（28 个）

```bash
B="node <bank>/cli.mjs"
```

| 命令 | 用途 |
|---|---|
| `init` | 初始化当前目录的银行 |
| `remember "内容" --page x.md` | 写入知识页（自动加当天日期、自动 reindex） |
| `recall "查询"` | 召回（`--json` 拿结构化结果、`--explain` 看打分构成） |
| `cue "文本" [--mode prompt\|output]` | 只看**触发词联想**（不起主召回），`--rebuild` 重建词表 |
| `explain` | 解释某次召回的分数构成 |
| `ingest [--full] [--cwd P]` | 增量摄入会话日志（`--full` 全量重跑） |
| `reflect [--days N]` | 深度反思（六节：话题/错误模式/纠正信号/未闭环/教训候选/建议） |
| `tick` | 定时任务入口：摄入 + 反思 + 整理 + 刷旧版记忆 |
| `tidy` | 整理归档：已完成待办 → archive、去重、压空行 |
| `preview` | **打印新会话会注入什么**（改完记忆结构必跑，这是唯一能验证「接得上」的手段） |
| `status` | 银行状态 |
| `page <文件>` | 读整页 |
| `items [--page x.md]` | 列条目（带 id 与行号） |
| `lines` | 各文件行数 vs 预算（架构红线） |
| `dead` | 死代码/多余导出审计 |
| `sweep` | 体检：配额、噪声、退役候选、推理退化扫描 |
| `prune --page x.md --match "正则" [--apply]` | 按正则退役条目（**默认干跑**，`--apply` 才写、先备份） |
| `sync [--diff] [--apply --from memory\|page]` | 主干（MEMORY.md）与知识页漂移检查（**默认只报告**） |
| `handoff [--write]` | 跨会话交接（读**倒数第二个**会话的末 5 轮；`--write` 落盘） |
| `lessons-audit [--days N]` | **教训哑弹审计**：写成 N 天零命中的退役候选（只报告不删） |
| `dream [--json] [--near] [--since D]` | 做梦：找「无共享标签却共享罕见词」的条目对 |
| `dream-inbox <list\|apply\|mark\|brief>` | 联想收件箱：后台攒的候选，人审后建边 |
| `ev <import\|list\|search\|related\|entity\|note\|link\|drop>` | 事件存储（SQLite，md 是权威、库是视图） |
| `mood <show\|set\|clear\|weight>` | 情绪状态（只影响联想排序与语气，**不参与事实判断**） |
| `memo <...>` | 备忘（待办 / 未提交 bug / 想聊的话题，带原话时间） |
| `watch <...>` | 盯 GitHub issue/PR 的回复 |
| `day` | 按天索引（生成 `pages/days/YYYY-MM-DD.md`） |
| `migrate` | 把旧的 `MEMORY.md` 迁移成知识页 |

---

## 五、自动化环节

| 环节 | 触发 | 实现 |
|---|---|---|
| 开场注入 | `SessionStart` hook | 13 段：全局偏好 / 待办索引 / 候选队列 / 联想收件箱 / 备忘 / 交接 / 近期事件 / 决策 / 故障速查 / 程序记忆 / 教训索引 / 气氛 / 用法 |
| 提问召回 | `UserPromptSubmit` hook | 主召回（阈值以上才注入）+ cue 联想（走单独通道） |
| 自动保存 | `UserPromptSubmit` hook（限流 90s） | 后台 `ingest` 增量抽取 → 流水 + 候选 + 索引 |
| 深度反思 | 计划任务 `DSH-Memory-Bank-Reflect`（每日 19:30） | `tick`：摄入 + 反思 + 整理 + 刷新 |
| 兜底保存 | 计划任务 `DSH-Memory-Bank-Save`（每 30 分钟） | hook 写入被沙箱拦时，仍保证落盘 |

**注入的三条铁律**（踩出来的）：
1. **截断必须按行边界**（`cutText`），不能用 `clip()`——后者把换行全压成空格、结构尽毁；
2. **注入内容禁用整段铺开**：只给索引 + 路径，细节让模型按需 `page`/`recall`；
3. **改完记忆结构必须 `preview`**，否则新会话接不上而你不知道。

---

## 六、四个「会学习」的机制

### 6.1 触发词联想（cue）

主召回是「以词查条目」，cue 是**反向的**：条目自带「看到这个词就想起我」。

```bash
node cli.mjs cue "又一次遇到 管道 的问题"
```

它和 `t:` 标签的分工：标签说「我属于这个主题」（粗），cue 说「别人提到这个词时该把我端出来」（精、**不要求对方也带同款标签**）。

**两级渲染**：p 最高的一条给正文，其余降级成「页｜标题」路牌——**名额不替模型砍，由模型读了路牌再决定要不要拉全文**。

### 6.2 做梦（发现未被注意的关联）

`dream` 找「无共享标签、却共享罕见词」的条目对。判据经过实测修正：
- **排除页头索引条目**（`页#0` 的正文是全页摘要，与谁都共享罕见词）；
- **same-event 日期分层**：同一件事的多页落点（events 记经过 / lessons 记结论 / faults 记速查）
  占候选的 88%，而这类边**检索收益≈0**（同一查询同时命中两端，被去重全挡掉）⇒ 默认只报**隔 3 天以上**的。

成立才建 `rel:` 边（`tools/rel-apply.mjs`，默认干跑）；否决的写进 `dream-discarded.json`（否则每天报同一批）。

### 6.3 教训哑弹审计（trial 质控）

```bash
node cli.mjs lessons-audit            # 默认 30 天观察期
```

**判据**：条目写成后 N 天内 `access.json` **零命中** ⇒ 哑弹候选。**只报告不删**——「零命中」只说明
没人问到过，不等于内容无用。裁决前先 `recall` 该条关键词复核。

⚠️ 这里有个真实踩过的坑值得知道：**`access.json` 的键是「页#条目序号」（索引里的第几条），不是文件行号**。
第一版实现拿文件行号去查，于是行号超出键范围的条目**必然零命中、必然被误判**——当时 203 条候选里
**201 条**的行号超过 access 键的最大序号，全是假阳性。
现在的实现直接读 `index.json` 的 docs，条目定义/编号/access 键三者天然同源。**引用任何统计数字前，先问「这个数怎么算出来的」。**

### 6.4 跨会话交接（handoff）

`handoff` 读**倒数第二个**会话日志的末 5 轮（当前那个是正在进行的会话），滚动覆盖写 `handoff.md`。

两个修正记录：
- **配对错位**：旧实现把 assistant 正文存成 pending、等下一条 user 认领 ⇒ 每行都是「后一轮的问题配前一轮的答案」。
  现改为**就地回填**：正文永远属于「当前最后一条有效轮次」。
- **空泛小结降级**：「这一轮已经完成。」这种进度播报占预算、零信息量。判据＝首段 ≤16 字且无数字且无代码
  ⇒ 降级成「（进度播报，无结论）」而非删除（保住「这轮发生过」这个事实）。
  门槛是**回放标定的**：12588 条 assistant 正文里命中 17.3%，试过放宽到 18/20 会发现 17~20 字档里有真结论 ⇒ 保持 16。

---

## 七、情绪系统（只影响想起什么与怎么说，不影响什么是对的）

三层权限，写在 `config-keys.mjs` 与 `decisions.md` 里：

| 通道 | 权重 |
|---|---|
| 联想/召回**排序** | ✅ 可加权，上限 +0.15，且**只加在 rank、不加进 score** ⇒ 情绪永远无法把无关条目捞出来 |
| 事实判断 / 结论 | ❌ **恒为 0**。情绪不是证据、不改变结论、不为迎合而软化或改口 |
| 措辞 / 语气 | ✅ 可调 |

两条硬机制：**写气氛必须带 `--evidence`（原话摘录）**，无证据拒写；**改口必须带 `--reason`**。
`mood.json` 放在 `pages/` **之外** ⇒ `recall` 物理搜不到情绪（隔离靠位置，不靠提示词自觉）。
危险档（会提前注入气氛段、允许无证据）默认关，用 `weight` 调。

---

## 八、安装与卸载

**已安装的部分**：

1. **包装插件包**（bundle 层，**必须放在 profile 内部**）
   - 部署位置：`%APPDATA%\dsh-desktop\harness\profiles\web\.local-bundles\dsh-memory-bank-hooks`
   - 源文件：`_dsh_memory/bank/bundle/`（`package.json` + `cordis.patch.yml`）
   - 它的 patch 用 `insert:` 新增挂载项 `mem-bank-hooks`，并注入 configPath
2. `@deepseek-ai/dsh-hooks-claude-code`：hook 桥接（经 junction 链接，**路径不能有空格**）
3. hook 配置：`hooks/hooks.json`
4. 计划任务：`DSH-Memory-Backup`（每 6 小时）、`DSH-Memory-Bank-Reflect`（每日 19:30）

**生效条件**：hook 属于**宿主半边**，需**完全退出并重启 DSH**（刷新页面不够）。

**卸载**：

```powershell
# 1) 移除包装包（挂载项随之消失）
node <dsh>/lib/bin.js plugin --profile web remove dsh-memory-bank-hooks
# 2) 移除桥接包（可选）
node <dsh>/lib/bin.js plugin --profile web remove @deepseek-ai/dsh-hooks-claude-code
# 3) 删除计划任务（可选）
Unregister-ScheduledTask -TaskName "DSH-Memory-Bank-Reflect" -Confirm:$false
```

---

## 九、已知边界（如实说）

- **关键词倒排，不是向量检索**：同义改写可能召回不到（别名表能补一部分，但覆盖有限）；
- `SessionStart` 注入是「脱离运行」的，**可能错过第一个请求**（桥接的已知限制）；
- 只支持 command hook；`Stop`/`PostToolUse` 部分未启用（`Stop` 阻塞会强制额外轮次，有死循环风险）；
- 会话日志是**多帧 zstd**，必须逐帧解压（`decompressAll`），普通解压只得到 1 行；
- 中文二元组会产出少量碎片词（如 `析一`，来自「解析一下」），属已知噪音；
- **条目 id 会漂移**：`页#第N条` 前面一增删就整体后移 ⇒ 所以 `rel:` 用**关键词**而不是编号；
  `access.json` 的键仍是序号，因此命中历史可能错位到邻居（哑弹审计会如实标出「有几个键指向已不存在的序号」）；
- **`node:sqlite` 的版本差**：Node 24 上只有 `DatabaseSync`（`Database` 不存在）；Node 25.7+ 才反过来
  把 `DatabaseSync` 标成废弃别名。**照最新文档改代码会在 Node 24 直接崩**——这是「官方文档 ≠ 你的运行时」的实例。

---

## 十、踩坑备忘（改这套系统前必读）

### 坑 1：新增挂载条目必须写在 `insert:` 下

平铺写在用户层 patch 里会报 `patch: entry "xxx" not found`（用户层只能覆盖/禁用已有 id）。
正确做法是用 **bundle 层 + `insert:`**：

```yaml
- insert:
    - id: mem-bank-hooks
      name: '@deepseek-ai/dsh-hooks-claude-code'
      config:
        configPath: <path>/hooks/hooks.json
        projectDir: <workspace>
        defaultTimeoutMs: 30000
```

### 坑 2（最隐蔽）：bundle 包必须放在 **profile 内部**

DSH 解析挂载项的 `name` 时，是以**拥有者包的真实路径**为基准去找 node_modules 的。
把包装包放在 profile 之外再 `link:` 进去，真实路径在别处，向上找不到 node_modules
→ **插件静默不加载（不报错、日志里也没有痕迹）**。

### 坑 3（最坑）：钩子命令由 **PowerShell** 执行，必须用 `&` 调用运算符

hook 命令按 PowerShell 语法解析。写 cmd 风格的 `"路径" "参数"` 会直接抛 `ParserError` ⇒ exitCode 1、钩子被跳过。

```json
"command": "& \"<node.cmd 路径>\" \"<user-prompt.mjs 路径>\""
```

### 坑 4：hook 跑在**受限沙箱**里，写文件会 EPERM

即使会话本身是 `danger-full-access`，hook 里写文件仍是 `EPERM`。
而 `recall(touch:true)` 写 `access.json` 失败会**抛异常** → 冒泡到 hook → **整轮注入一条都发不出去**。
⇒ **hook 侧一切写入必须自己吞异常**。

### 诊断钩子是否真的在跑

调用与结果写进**会话日志**（多帧解压后 grep `type":"hook/invoked"` 与 `"hook/result"`）：

- `hook/invoked` 出现 → 桥接已加载并触发；
- `exitCode: 0` → 成功；`exitCode: 1` + `stderrSummary` → 命令本身失败（多数是引号/语法问题）；
- `decision: pass` → 失败也不阻塞对话。

⚠️ **注入的真实载体不是 `user/message`**：插件注入走 `user/message` 且带 `source.kind="plugin:..."`；
而开场注入可能出现在 `agent/inbox/spliced` 的 `data.inserted[].content[].text`。找注入找错字段会一无所获。

### 自检四步（改完必须跑）

```powershell
# ① 组合树里要有条目且无 not found
node <dsh>/lib/bin.js --profile web --dump-config > _dump.txt 2>&1
Select-String _dump.txt -Pattern "mem-bank-hooks|not found"
# ② profile 依赖与 bundles 里都要有
node <dsh>/lib/bin.js plugin --profile web list
# ③ 从 bundle 目录能否解析桥接包
node -e "import('@deepseek-ai/dsh-hooks-claude-code').then(m=>console.log('OK')).catch(e=>console.log('FAIL',e.code))"
# ④ 用 PowerShell 语法实跑 hook 命令（payload 里的路径写双反斜杠）
```

**生效判定**：重启后发任意一条消息 → `repos/<slug>/.bg.json` 的 mtime 刷新；或看会话日志 `hook/result` 的 `exitCode` 是否为 0。

---

## 十一、测试与架构红线

```bash
node <bank>/test.mjs          # 全套断言
node <bank>/cli.mjs lines     # 各文件行数 vs 预算
```

**clone 下来就能跑**：`repos/`（个人记忆数据）不进仓库，所以测试在找不到本地银行时会
**自动建一个夹具库**（`test-fixture.mjs`：内容自己编、结构等价 —— 别名分组、表格行、条目元数据、
TOC、定时条目、归档页、会话流水），于是同一套断言在你机器上照样真跑。
实测：干净 clone 下 `343 通过 / 0 失败 / 5 跳过`（跳过项是「个人专用工具未入库」的行数检查）。

**要求 Node ≥ 22.5**（`node:sqlite` 从 22.5 引入；建议 24+ LTS）。

**架构红线**（借自 dsh-pet 的做法，由测试守护、红了即失败）：每个文件有行数预算，
超限**先按域拆分，不准压缩行宽硬塞**；预算只随实测校准，上调必须给理由。
> 实际救过场：一个文件加 30 行说明性注释就顶爆了 150 行预算——**注释同样计入**。

---

## 十二、License

MIT

---

### 附：关于注释里的「主人」

本项目最初是给一位用户私人使用的系统，早期注释里把使用者称作「主人」（这是当时的对话称呼）。
开源版**保留了这些注释**，因为它们记录的是「这条规则是谁、在什么时候、因为什么要求加的」——
那个历史信息比称呼本身有价值。

阅读时把它理解成「使用者 / 你」即可。注意有几处「主人」是**功能数据而非称呼**，不要顺手改掉：

| 位置 | 为什么不能改 |
|---|---|
| `core.mjs` 的停用词表 | 它是分词时被过滤的高频词之一 |
| `core.mjs` / `cli.mjs` 的 `主人（用户）画像` | 是页名映射键，改了 `sync` 找不到段 |
| `handoff.mjs` 的两条正则 | 用于剥掉「主人，…」这类寒暄前缀 |
| `ev-autolog.mjs` 的 `主人：<原话>` | 是事件库的数据格式，改了与存量事件不兼容 |
