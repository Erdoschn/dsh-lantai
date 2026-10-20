# 兰台·簿 (Lantai Bu) · dsh-lantai

> A ledger for what your agent learned: every lesson is written down, what gets
> written has to pass inspection, and what goes stale gets retired.

**One minute to install, and it will tell you which skills in your library are
currently misleading you.**

```console
dsh plugin install dsh-lantai
```

Then ask it to "run a health check on my skills":

```
7 skills, 4 themes, 0 high, 0 medium, 3 notes
[low] theme "windows" has only 2 entries → a knowledge gap, and a hint at what to learn next
```

---

## A model writes something offhand — and it is rejected outright

```
rejected, not a single byte written:
[name-not-kebab]          name "Git_Auth" must be kebab-case
[description-vague]       description is too vague
[body-too-short]          body is under 6 lines, too thin to be a procedure
[missing-verification]    no "Verification" section: a skill without a way to check it is a rumour, not experience
[missing-boundaries]      no "Boundaries" section: a skill with no stated limits gets treated as universal
[not-concrete]            no concrete command, path or field name anywhere
[disable-guardrail]       never recommend disabling the sandbox or the approval gate
[push-to-default-branch]  never push straight to the default branch; push a branch and open a PR
```

The last two are safety findings: **that draft was teaching people to switch off the
sandbox and push straight to main.**

Without the check it would have been filed away, and then taken effect in every
matching session from then on — you would never read it again, but it would keep
steering the agent's judgement.

## Why the check exists

A skill is injected into **every** matching session from then on, and becomes one of
the agent's standing assumptions.

So the question is not "is this useful" but "**what happens if it is wrong**". A wrong
skill is not like a wrong search result — a search result you simply don't read. A
skill takes part in every judgement, and nobody rereads it.

> Something remembered that is wrong, stale, or contradicting itself is worse than
> something forgotten.

## Three actions, all of them subtractive

**Health check (兰台·诊)** — whether the skills are yours, someone else's, or pulled
from GitHub, one call reports: contradictions, islands, thin coverage, overdue
reviews, and missing verification. Every finding says what to do about it. Read-only;
it changes no files.

**Graph (兰台·谱)** — themes plus structural edges that can be proven from text,
emitted as JSON or as a Mermaid diagram you can drop into a README. The edges are all
inferred from the text, so imported skills get a graph too.

**The check (核验)** — everything is inspected before it is written; a rejection
writes not a single byte. Four kinds of rule: shape, substance, safety, uniqueness.

## Review ladder (勘程)

The interval is decided by **how many times the skill has been reviewed**.

| Stage | Interval | What to do |
| --- | --- | --- |
| 0 | 7 days | Light check: does the verification command still pass? |
| 1 | 14 days | Re-check |
| 2 | 30 days | Environment: did versions, paths or flags move? |
| 3 | 60 days | Value: has a better approach replaced it? |
| 4 | 90 days | Cost: how often is it loaded, is it still worth the context? |
| 5 | 180 days | Final: rewrite, shrink, or delete |

Past 180 days overdue, the health check recommends archiving — **but it never deletes
on its own.**

## Archive, not delete (归档)

`skill_retire` shows a confirmation card first; once you agree, the directory is
archived to `skills.retired/<name>-<timestamp>/`, with a `RETIRED.md` recording the
reason and how to restore it.

**The reason is mandatory.** Without one, the card never appears — six months from now
you need to know why this directory exists.

## Eight tools

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

## Security boundary

| What it does control | What it does not control |
| --- | --- |
| An agent writing a skill with no verification | An agent writing `~/.dsh/skills` directly through a shell |
| Two skills contradicting each other unnoticed | An agent that deliberately routes around the check |
| A skill quietly becoming a permanent assumption | A stale skill still being injected (only the review ladder can prompt) |

- **It has more permission than an agent inside the sandbox** — it writes outside the
  workspace.

## Install

```console
dsh plugin install dsh-lantai
```

Or add one row to your profile:

```yaml
- id: lantai
  name: 'dsh-lantai'
  config:
    skillRoot: '~/.dsh/skills'
    allowReplace: false
    nudge: true
```

## How it differs from other memory schemes

| | Most memory / skill schemes | 兰台·簿 |
| --- | --- | --- |
| Stance | Remember as much as possible | **Partial writes are not allowed. Whatever is written must be valid and harmless. Whatever is stale must be retired.** |
| Writing | Appended directly | Passes the check; rejected otherwise |
| Expiry | No mechanism | Review ladder |
| Removal | Deleted | Archived with a reason, recoverable |
| Can it say "this skill is misleading you right now" | No | **That is the point of the health check** |

## License

MIT

---

[中文](README.md) | English
