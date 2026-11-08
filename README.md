# DSH 记忆库使用说明

这个目录是给"未来的会话"准备的长期记忆，放在工作区里，可以随时打包备份、复制到别的机器。

## 目录结构

```
_dsh_memory/
├─ MEMORY.md              ← 记忆主干（新会话先读这份，由助手维护）
├─ STATUS.md              ← 状态面板（自动生成：会话统计 + 工作区变化）
├─ INDEX.md               ← 工作区文件索引
├─ README.md              ← 本文件
├─ auto_memory.mjs        ← ★ 一键自动更新记忆（备份 + 摘要 + 状态）
├─ zstd_multi.mjs         ← 多帧 zstd 解压模块（会话日志必需）
├─ backup_sessions.mjs    ← 只备份会话日志
├─ read_session.mjs       ← 把会话日志解压成可读 jsonl
├─ digest/                ← 会话摘要（latest.md / latest.json / 历史）
├─ state/                 ← 工作区快照（用于对比新增/删除）
└─ sessions/              ← 会话日志备份（*.jsonl.zstd + manifest-*.json）
```

## 自动更新到哪一层

| 层 | 内容 | 自动化程度 |
|---|---|---|
| 机械层 | 备份会话日志、生成时间线摘要、统计工具使用、刷新工作区文件变化 | ✅ **全自动**（`auto_memory.mjs` + 计划任务） |
| 语义层 | 提炼"学到了什么、待办有哪些、偏好变化"并改写 `MEMORY.md` | ⚠️ **半自动**：`AGENTS.md` 里已写规则，助手每次收尾时会执行；也可直接对它说「更新记忆」 |

一条命令刷新全部：

```
node E:\2\_dsh_memory\auto_memory.mjs
```

## 为什么需要它

助手的"记忆"分三层，缺一不可：

| 层 | 载体 | 特点 |
|---|---|---|
| 会话内记忆 | 当前对话上下文 | 关了会话就没了 |
| **工作区指令** | `E:\2\AGENTS.md` | **每个新会话自动加载**，是"让未来的我知道该读什么"的入口 |
| **落盘记忆** | 本目录的 `MEMORY.md` / `INDEX.md` | 长期保存、可备份、跨机器可用 |

DSH 的 `dsh-agent-instructions` 插件会在每个新会话的第一次请求里注入工作区指令链（从项目根到工作目录的 `AGENTS.md` / `CLAUDE.md`），所以 `E:\2\AGENTS.md` 里的提示会自动生效。

## 日常怎么用

1. **想让助手记住新的事**：对它说「更新记忆」，它会改写 `MEMORY.md`；
2. **新会话想恢复上下文**：说「先读 `_dsh_memory/MEMORY.md`」即可（`AGENTS.md` 里也写了这条提示）；
3. **备份会话日志**：`node E:\2\_dsh_memory\backup_sessions.mjs`
4. **查看某次会话的原文**：
   ```
   node E:\2\_dsh_memory\read_session.mjs "E:\2\_dsh_memory\sessions\<会话目录>__session.jsonl.zstd"
   ```
   （解压后是 JSONL，每行一条消息；需要 Node 22.15+ 才能内置解压）

## 想自动备份？加一个计划任务

以管理员身份打开 PowerShell，注册一个每 6 小时跑一次的任务：

```powershell
$action  = New-ScheduledTaskAction -Execute "node" -Argument "E:\2\_dsh_memory\backup_sessions.mjs"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 6)
Register-ScheduledTask -TaskName "DSH-Memory-Backup" -Action $action -Trigger $trigger -Description "备份 DSH 会话日志"
```

删除任务：`Unregister-ScheduledTask -TaskName "DSH-Memory-Backup"`

## 局限（要如实知道的）

> ⚠️ **先把两层的分工说清**：本 README 讲的是**旧版记忆库**（`MEMORY.md` 那一层，靠助手主动去读）。
> 真正自动工作的是 `bank/`（**记忆银行**）—— 它靠 hook **自动注入**，不需要助手"记得去读"。
> 下面第 1 条的旧说法已经作废，保留删除线是为了让人看得出改过什么。

- ~~这些文件是**文本记录**，跨会话时仍需**显式读取**（`AGENTS.md` 负责提醒这件事）~~
  —— **这一条对记忆银行已不成立**：`SessionStart` hook 开场自动注入 13 段摘要
  （全局偏好 / 待办索引 / 近期事件 / 重要决策 / 故障速查 / 程序记忆 / 教训索引 …，实测约 7800 字）；
  `UserPromptSubmit` hook 每轮按提问召回。**助手不需要被提醒去看文件。**
  ⚠️ 但注入有**总预算 8000 字、按段配额**——细节仍需按需 `recall` / `page`，
  **被配额截掉的那几段不会自己出现**（这是它唯一的"局限"，也是预算换来的确定性）。
- 仍然成立的部分：注入进上下文的那部分才算"记住了"，没进注入的只是"**可查到**"；
- 会话日志是**多帧 zstd** 压缩的 JSONL，能翻查原文，但不会自动变成上下文；
- `MEMORY.md` 写得越精炼越好——太长会占每个会话的上下文预算（记忆银行的注入预算同理）。
