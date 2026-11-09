# 变更记录（CHANGELOG）

> 本仓库是「零依赖的 Agent 长期记忆系统」的**实现**，不是某个人记忆内容的备份。
> 个人内容（`repos/`、`sessions/`、`digest/`、`MEMORY.md` 等）由 `.gitignore` 整体排除，首次运行自动生成。
> 简版见 [CHANGELOG-SIMPLE.md](./CHANGELOG-SIMPLE.md)。

最新在上。

---

## 2026-11-09 · 按域拆分 + LLM 抽取通道 + 预算策略修正

**规模**：29 个文件修改（+936 / −1702 行，净 −766）· 69 个新文件 = **42 个域模块** + 24 个测试 + 3 个工具
**验证**：38 个测试文件 / **719 条断言全绿**（`node bank/test.mjs`，退出码 0）
**当前体量**：`bank/` 19381 行（120 个模块）· `tools/` 4439 行 · CLI **31 个命令**

### 一句话

几个「什么都装」的大文件按职责拆成 42 个小模块；同时补上 LLM 抽取通道、索引治理、并发安全写等能力；并把行数预算从「目标值」正名为「可读性护栏」。

### 新增能力

| 能力 | 入口 / 模块 | 说明 |
|---|---|---|
| LLM 抽取通道 | `bank/extract.mjs` + `extract-config/prompt/parse/store` | 把对话喂给模型、抽成结构化候选再落盘；带游标 + 分批，失败可从最后成功的批复跑 |
| 关系编辑 | `cli rel`（`commands/rel.mjs`，371 行） | 手工增删条目间关系；`rel` / `rel2` / `cooccur` / `tag` 四类来源可分辨 |
| 备份轮转 | `cli rotate` + `bank/bak-rotate.mjs` | 备份按数量 / 体积轮转，可挂进 tick |
| 索引治理三件套 | `index-schema.mjs` / `index-guard.mjs` / `index-rebuild.mjs` | 结构版本自描述 + 写后自检 + 批量重建的「失败率门」（超阈值不切换） |
| 召回诊断 | `cli explain` + `explain-basis.mjs` | 逐条给出 `match_basis`，判不出来的**拒绝硬凑** |
| 短查询扩展 | `bank/hooks/query-expand.mjs` | 「接续性提问」自动拼接上一轮用户话，四道门 |
| 配置值域 | `bank/config-clamp.mjs` | 配置键声明值域 + 写入时夹紧，越界不留脏值 |
| 并发安全写 | `bank/safe-write.mjs` | 读-改-写原子化，防两个进程同时改同一页 |
| 碎片复读检测 | `bank/frag-metrics.mjs` | 单条思考的碎片指标 + 自动判据 |
| tick 断点日志 | `bank/tick-log.mjs` + `commands/tick-maintain.mjs` | 每段落盘，崩了磁盘正好停在最后一个跑完的段 |
| 图谱连边 | `tools/graph-edit-lib.mjs` + `graph-edit-domstub.mjs` | 「点两个节点 → 生成连边」的唯一实现，可在 Node 里真执行 |

> `tools/graph-render.mjs` **逆势增行 382 → 595**：它不是拆分产物，是把星图生成器补全（LINKS / DAYS / body + `clusterById` 的 TDZ 修复）。

### 按域拆分对照（变化最大的 10 个）

| 文件 | 拆分前 | 拆分后 | 拆出的域 |
|---|---:|---:|---|
| `bank/core.mjs` | 489 | 321 | `core-text` / `core-transcript` |
| `bank/mood.mjs` | 349 | 221 | `mood-weight` / `mood-render` |
| `bank/evstore.mjs` | 294 | 168 | `evstore-schema` / `evstore-parse` |
| `bank/dream-inbox.mjs` | 260 | 170 | `dream-inbox-store` / `dream-report` |
| `bank/degenerate-audit.mjs` | 239 | 139 | `degenerate-audit-report` |
| `bank/test.mjs` | 439 | 374 | 24 个独立测试文件 |
| `tools/page-toc.mjs` | 221 | 105 | `page-toc-kinds` |
| `bank/reflect.mjs` | 207 | 152 | `reflect-cand` / `reflect-clues` |
| `bank/index.mjs` | 160 | 69 | `index-schema` / `index-guard` / `index-rebuild` / `index-status` |
| `bank/hooks/pre-tool.mjs` | 146 | 67 | `pre-tool-rules` |

其余同步拆分的：`search.mjs` → `search-context` + `search-recall` + `recall-assemble`；`assoc.mjs` → `assoc-edges`；`hooks/user-prompt.mjs` → `prompt-hard` + `prompt-recall`。

### 策略与规范变更

**行数预算从「目标值」改成「可读性护栏」（`bank/budgets.json`）**

- 旧：`预算 = 实测 × 1.1`（紧了就拆、拆完再收紧）
- 新：`预算 = max( 实测 × 1.2 向上取整到十位, 200, 原预算 )` —— **只放宽、不收紧**
- 理由：预算的意义是「别一个文件几千行、谁都不敢改」，**不是**「到了就出 bug 的物理红线」。收紧会让每个文件贴着 90% 运行，改一行又得拆，把预防变成高频劳动。
- 唯一一次例外：`bank/bank.mjs` 从 1960 收到 **560**（实测 464 行，原值只占 24%，等于一层从未生效过的护栏）。
- 预算表现在覆盖 **161 个文件**，由测试守护（红了即失败）。

### 清理

- 注释与用法里的**硬编码本机路径**已泛化（`E:\2\...` → 相对路径 / 占位符），沿用 `65c6b8d` 的口径。
- `.gitignore` 保持「只让代码和模板进仓库」：个人知识页、会话日志、摘要、快照、备份、凭证路径工具一律排除。

### 已知限制

- 个人内容不在仓库里：clone 下来拿到的是**系统实现**，知识页在首次运行时自建。
- 零外部依赖（纯 Node 标准库），但会话日志解压需要 **Node 22.15+**（内置 `zstd`）。
