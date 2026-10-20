# 兰台·簿 · dsh-lantai

> 一本账册：agent 学到的经验记一笔，记什么要审，过期要核销。

> A ledger for what your agent learned: every lesson is written down, what gets
> written has to pass inspection, and what goes stale gets retired.

**装上只要一分钟，它能告诉你手上的 skill 库哪几条在误导你。**

**One minute to install, and it will tell you which skills in your library are
currently misleading you.**

```console
dsh plugin install dsh-lantai
```

然后问它一句"体检一下我的 skill"：

```
7 条 skill，4 个主题，0 个严重、0 个中等问题、3 个提示
[low] 主题「windows」只有 2 条 → 知识缺口，也是下一步该学什么的方向
```

---

## 模型随手写一些，但没通过核验被打回

## A model writes something offhand — and it is rejected outright

```
核验驳回，一字未写：
[name-not-kebab]          name "Git_Auth" 必须是 kebab-case
[description-vague]       description 太笼统
[body-too-short]          正文少于 6 行，撑不起一份操作手册
[missing-verification]    缺少「验证」小节：没有验证方式的 skill 是谣言，不是经验
[missing-boundaries]      缺少「边界」小节：不说边界的经验会被当成万能的
[not-concrete]            正文里没有具体的命令、路径或字段名
[disable-guardrail]       不能建议关闭或绕过沙箱与审批
[push-to-default-branch]  不能建议直推默认分支；改为推送分支后开 PR
```

最后两条是安全问题：**那条草稿在教人关掉沙箱、直推主分支。**

The last two are safety findings: **that draft was teaching people to switch off the
sandbox and push straight to main.**

如果没有核验，它会入册，然后在往后每一个匹配的会话里生效——你不会再读它，但它一直影响 agent 的判断。

Without the check it would have been filed away, and then taken effect in every
matching session from then on — you would never read it again, but it would keep
steering the agent's judgement.

## 为什么需要核验

## Why the check exists

一条 skill 会被注入到此后**每一个**匹配会话，成为 agent 的默认前提。

A skill is injected into **every** matching session from then on, and becomes one of
the agent's standing assumptions.

所以判断标准不是"这条有没有用"，而是"**它错了会怎样**"。错的 skill 不像错的搜索结果——你不看就没影响；它会主动参与每一次判断，而且没人会再读一遍。

So the question is not "is this useful" but "**what happens if it is wrong**". A wrong
skill is not like a wrong search result — a search result you simply don't read. A
skill takes part in every judgement, and nobody rereads it.

> 记住的东西如果错了、旧了、互相打架，比不记得更糟。

> Something remembered that is wrong, stale, or contradicting itself is worse than
> something forgotten.

## 三个动作，都在做减法

## Three actions, all of them subtractive

**体检（兰台·诊）** —— 不管 skill 是你写的、别人给的还是从 GitHub 拉的，一次给出：矛盾、孤岛、薄覆盖、逾期、缺验。每条都带"该做什么"。只读，不改文件。

**Health check (兰台·诊)** — whether the skills are yours, someone else's, or pulled
from GitHub, one call reports: contradictions, islands, thin coverage, overdue
reviews, and missing verification. Every finding says what to do about it. Read-only;
it changes no files.

**图谱** —— 主题聚簇 + 可证实的实边，输出可直接嵌 README 的 Mermaid。边全从文本推出，所以导入的 skill 也能建图。

**Graph (兰台·谱)** — themes plus structural edges that can be proven from text,
emitted as JSON or as a Mermaid diagram you can drop into a README. The edges are all
inferred from the text, so imported skills get a graph too.

**核验** —— 写入前先审，驳回时一字不写。规则四类：形状、实质、安全、唯一。

**The check (核验)** — everything is inspected before it is written; a rejection
writes not a single byte. Four kinds of rule: shape, substance, safety, uniqueness.

## 勘程（阶梯化复核）

## Review ladder (勘程)

勘程间隔由**已勘次数**决定。

The interval is decided by **how many times the skill has been reviewed**.

| 阶段 | 间隔 | 该做什么 |
| --- | --- | --- |
| 0 | 7 天 | 轻勘：验证命令还通得过吗 |
| 1 | 14 天 | 复查 |
| 2 | 30 天 | 环境复核：版本、路径、开关变了没 |
| 3 | 60 天 | 价值复核：被更好的做法取代了吗 |
| 4 | 90 天 | 成本复核：命中率如何，还值得占上下文吗 |
| 5 | 180 天 | 终审：重写、收缩，或删除 |

| Stage | Interval | What to do |
| --- | --- | --- |
| 0 | 7 days | Light check: does the verification command still pass? |
| 1 | 14 days | Re-check |
| 2 | 30 days | Environment: did versions, paths or flags move? |
| 3 | 60 days | Value: has a better approach replaced it? |
| 4 | 90 days | Cost: how often is it loaded, is it still worth the context? |
| 5 | 180 days | Final: rewrite, shrink, or delete |

逾期超过 180 天，诊录会建议归档——**但不会自动删。**

Past 180 days overdue, the health check recommends archiving — **but it never deletes
on its own.**

## 归档（可撤回的删除）

## Archive, not delete (归档)

`skill_retire` 先出示确认卡片，同意后归档，目录移到 `skills.retired/<name>-<时间戳>/`，留一份 `RETIRED.md` 记下原因与恢复方式。

`skill_retire` shows a confirmation card first; once you agree, the directory is
archived to `skills.retired/<name>-<timestamp>/`, with a `RETIRED.md` recording the
reason and how to restore it.

**归档原因必填。** 没有原因，连卡片都不会弹——你半年后看到它，得知道当初为什么。

**The reason is mandatory.** Without one, the card never appears — six months from now
you need to know why this directory exists.

## 八个工具

## Eight tools

| 工具 | 卡片名 | 干什么 |
| --- | --- | --- |
| `skill_health` | 兰台·诊 | 诊录：矛盾、孤条、单薄、逾期、缺验 |
| `skill_graph` | 兰台·谱 | 主题聚簇 + 实边，输出 JSON / Mermaid |
| `skill_distill` | 兰台·录 | 过核验后入册 |
| `skill_catalog` | 兰台·索 | 列出目录、复核等级、下次复核时间 |
| `skill_audit` | 兰台·校 | 算到期，列出该跑的验证命令 |
| `skill_attest` | 兰台·勘 | 盖章，间隔自动拉长 |
| `skill_retire` | 兰台·削 | 确认后归档，可恢复 |
| `skill_conflicts` | 兰台·议 | 两两比对，只报可疑与证据 |

| Tool | Card name | What it does |
| --- | --- | --- |
| `skill_health` | 兰台·诊 | Report: contradictions, islands, thin coverage, overdue, missing verification |
| `skill_graph` | 兰台·谱 | Themes + real edges, as JSON or Mermaid |
| `skill_distill` | 兰台·录 | Write only after the check passes |
| `skill_catalog` | 兰台·索 | List the library, review stage, next review date |
| `skill_audit` | 兰台·校 | Work out what is due and name the command to run |
| `skill_attest` | 兰台·勘 | Stamp a review; the interval grows automatically |
| `skill_retire` | 兰台·削 | Archive after confirmation, recoverable |
| `skill_conflicts` | 兰台·议 | Pairwise comparison; reports suspicions with evidence |

## 安全边界

## Security boundary

| 兰台可控权限 | 无控制权 |
| --- | --- |
| agent 写一条没有验证方式的 skill | agent 用 shell 直接写 `~/.dsh/skills` |
| 两条 skill 互相矛盾而无人察觉 | 蓄意绕过核验的 agent |
| skill 悄悄变成永远生效的默认前提 | 过期的 skill 继续被注入（只能靠勘程提醒） |

| What it does control | What it does not control |
| --- | --- |
| An agent writing a skill with no verification | An agent writing `~/.dsh/skills` directly through a shell |
| Two skills contradicting each other unnoticed | An agent that deliberately routes around the check |
| A skill quietly becoming a permanent assumption | A stale skill still being injected (only the review ladder can prompt) |

- **对比 sandbox 里的 agent 权限更大**——拥有写入工作区之外的权限。

- **It has more permission than an agent inside the sandbox** — it writes outside the
  workspace.

## 安装

## Install

```console
dsh plugin install dsh-lantai
```

或在 profile 里加一行：

Or add one row to your profile:

```yaml
- id: lantai
  name: 'dsh-lantai'
  config:
    skillRoot: '~/.dsh/skills'
    allowReplace: false
    nudge: true
```

## 和其它记忆方案的区别

## How it differs from other memory schemes

|  | 大多数 memory / skill 方案 | 兰台·簿 |
| --- | --- | --- |
| 立场 | 记得越多越好 | **部分写入要求不被允许。写入的必定有效、无害。过时的应该淘汰。** |
| 写入 | 直接追加 | 过核验，不通过就驳回 |
| 过期 | 没有机制 | 勘程 |
| 删除 | 删了 | 归档 + 原因，可恢复 |
| 能否指出"这条skill现在在误导你" | 不能 | **体检的直接目的** |

| | Most memory / skill schemes | 兰台·簿 |
| --- | --- | --- |
| Stance | Remember as much as possible | **Partial writes are not allowed. Whatever is written must be valid and harmless. Whatever is stale must be retired.** |
| Writing | Appended directly | Passes the check; rejected otherwise |
| Expiry | No mechanism | Review ladder |
| Removal | Deleted | Archived with a reason, recoverable |
| Can it say "this skill is misleading you right now" | No | **That is the point of the health check** |

## License

MIT
