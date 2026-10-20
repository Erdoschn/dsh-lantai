/**
 * 兰台 · the four tools.
 *
 * Registered without `defineTool()` on purpose: this package stays dependency-free
 * so `pnpm add` never has to resolve a peer. The price is that we must reproduce
 * what `defineTool()` does — compile the parameter spec and validate arguments —
 * which `./schema.js` does and `test/contract.test.mjs` proves.
 */
import path from 'node:path';
import { compileParameters, validateArgs } from './schema.js';
import { gate, extractVerificationCommand } from './rules.js';
import { INTERVALS, computeSchedule, nextStage } from './decay.js';
import { archiveSkill, attestSkill, findSkillFile, listSkillNames, listSkills, writeSkill } from './skill.js';

export class ToolError extends Error {
  constructor(message, { hint, violations } = {}) {
    super(message);
    this.name = 'ToolError';
    this.hint = hint;
    this.violations = violations;
  }
}

const OUTPUT = { type: 'object' };
const DAY_MS = 86400000;

function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

function describeViolations(violations) {
  return violations.map((violation) => `[${violation.code}] ${violation.message}`).join('\n');
}
function requireValid(parameters, args) {
  const violations = validateArgs(parameters, args);
  if (violations.length > 0) {
    throw new ToolError(`参数不合法：${violations.join('；')}`, { violations });
  }
}

function sessionIdOf(exec) {
  const agent = exec && exec.agent;
  if (!agent) return null;
  const session = agent.session;
  return (session && session.id) || agent.id || null;
}

/**
 * @param {{config: {skillRoot: string, allowReplace: boolean}, problems?: string[], now?: () => Date}} deps
 */
export function buildTools({ config, problems = [], requestApproval, now = () => new Date() }) {
  const root = config.skillRoot;

  function assertReady() {
    if (problems.length > 0) {
      throw new ToolError(`兰台配置有误，未执行任何操作：\n- ${problems.join('\n- ')}`, {
        hint: '修正 profile 里 lantai 这一行的 config 后重试',
      });
    }
  }

  /**
   * A skill that 兰台 did not write has no distilledAt. Falling back to the file's
   * mtime keeps those skills inside the ladder instead of making them invisible to
   * every audit — an adopted skill is marked as such so the report stays honest.
   */
  function scheduleOf(skill, clock) {
    const adopted = !skill.distilledAt && Boolean(skill.modifiedAt);
    return {
      adopted,
      ...computeSchedule({
        distilledAt: skill.distilledAt ?? skill.modifiedAt,
        reviewedAt: skill.reviewedAt,
        stage: skill.stage,
        status: skill.status,
        reviewCount: skill.reviewCount,
        now: clock,
      }),
    };
  }

  const distillParameters = compileParameters(
    {
      name: { type: 'string', required: true, description: 'kebab-case 标识，同时是目录名。' },
      description: {
        type: 'string',
        required: true,
        description: '一句话说明用途；模型据此决定要不要加载，所以要具体。',
      },
      whenToUse: { type: 'string', description: '什么时候该用这条 skill。' },
      body: { type: 'string', required: true, description: 'Markdown 正文，必须含「验证」与「边界」两节。' },
      replace: { type: 'boolean', description: '已存在同名 skill 时才允许覆盖；旧文件备份为 .bak。' },
    },
    'skill_distill.parameters',
  );

  const catalogParameters = compileParameters({}, 'skill_catalog.parameters');

  const auditParameters = compileParameters(
    {
      name: { type: 'string', description: '只体检这一条；省略则检查全部。' },
      dueOnly: { type: 'boolean', description: '只返回已到期、该复核的条目。' },
    },
    'skill_audit.parameters',
  );

  const attestParameters = compileParameters(
    {
      name: { type: 'string', required: true, description: '刚刚核对过的 skill 名字。' },
      note: { type: 'string', description: '这次核对的结论，写进 frontmatter 备查。' },
    },
    'skill_attest.parameters',
  );

  const retireParameters = compileParameters(
    {
      name: { type: 'string', required: true, description: '要归档的 skill 名字。' },
      reason: { type: 'string', required: true, description: '为什么归档它；会写进确认卡片和归档记录。' },
    },
    'skill_retire.parameters',
  );
  return [
    {
      name: 'skill_distill',
      description:
        '兰台·录 — 把一条经验沉淀成 skill：先过闸门（命名、查重、必须有验证方式与边界、禁止危险授权），通过后才写入 ~/.dsh/skills。被拒时会逐条说明原因。返回值同时给出正文，便于当前这一步直接照着做。新写入的 skill 从复核阶梯第 0 级（7 天后首次复核）开始。',
      parameters: distillParameters,
      output: { schema: OUTPUT, render: (_args, value) => text(value) },
      async execute(args, exec) {
        assertReady();
        requireValid(distillParameters, args);
        const allowReplace = args.replace === true;
        if (allowReplace && config.allowReplace !== true) {
          throw new ToolError('本插件未开放覆盖（config.allowReplace 为 false）', {
            hint: '让用户确认后，把 profile 里的 allowReplace 改成 true；或换一个 skill 名字',
          });
        }

        const existingNames = await listSkillNames(root);
        const verdict = gate(
          { name: args.name, description: args.description, whenToUse: args.whenToUse, body: args.body },
          { existingNames, allowReplace },
        );
        if (!verdict.ok) {
          throw new ToolError(`闸门拒收，未写入任何文件：\n${describeViolations(verdict.violations)}`, {
            hint: '按上面的条目改正文或名字后重试；不需要重写整篇，只补缺的部分',
            violations: verdict.violations,
          });
        }

        const createdAt = now().toISOString();
        const provenance = {
          distilledAt: createdAt,
          session: sessionIdOf(exec) ?? '',
          model: 'deepseek-harness',
          stage: '0',
          reviewCount: '0',
        };
        const written = await writeSkill(
          root,
          {
            name: args.name.trim(),
            description: args.description,
            whenToUse: args.whenToUse,
            body: args.body,
            provenance,
          },
          { replace: allowReplace },
        );

        return {
          ok: true,
          title: '兰台·录',
          name: args.name.trim(),
          path: written.path,
          bytes: written.bytes,
          backup: written.backup,
          stage: 0,
          nextReviewAt: new Date(Date.parse(createdAt) + INTERVALS[0] * DAY_MS).toISOString(),
          note: '已写入磁盘。会话目录刷新有延迟，所以正文一并附在下面，当前这一步可以直接照着执行。',
          body: args.body,
        };
      },
    },
    {
      name: 'skill_catalog',
      description:
        '兰台·索 — 列出 ~/.dsh/skills 下已有的 skill：名字、描述、适用范围、来源、复核等级、下次复核时间、路径。写入之前先查重。',
      parameters: catalogParameters,
      output: { schema: OUTPUT, render: (_args, value) => text(value) },
      async execute(args) {
        assertReady();
        requireValid(catalogParameters, args);
        const clock = now();
        const skills = await listSkills(root);
        return {
          title: '兰台·索',
          root,
          count: skills.length,
          skills: skills.map((skill) => {
            const schedule = scheduleOf(skill, clock);
            return {
              name: skill.name,
              description: skill.description,
              whenToUse: skill.whenToUse,
              source: skill.source,
              stage: skill.stage,
              reviewCount: skill.reviewCount,
              adopted: schedule.adopted === true,
              nextReviewAt: schedule.ok ? schedule.dueAt : null,
              due: schedule.ok ? schedule.due : false,
              path: skill.path,
              ...(skill.error ? { error: skill.error } : {}),
            };
          }),
        };
      },
    },
    {
      name: 'skill_audit',
      description:
        '兰台·校 — 体检已有 skill：按复核阶梯算出哪些到期（间隔 7/14/30/60/90/180 天，随复核次数递增，不是随日历重置），重新过一遍闸门规则，列出该跑的验证命令，并对长期无人处理的条目建议删除。它不执行任何命令。',
      parameters: auditParameters,
      output: { schema: OUTPUT, render: (_args, value) => text(value) },
      async execute(args) {
        assertReady();
        requireValid(auditParameters, args);
        const clock = now();
        const skills = await listSkills(root);
        const selected = args.name ? skills.filter((skill) => skill.name === args.name) : skills;
        if (args.name && selected.length === 0) {
          throw new ToolError(`没有名为 "${args.name}" 的 skill`, { hint: '先用 skill_catalog 看看有哪些' });
        }

        const results = selected.map((skill) => {
          const schedule = scheduleOf(skill, clock);
          const verdict = skill.error
            ? { ok: false, violations: [{ code: 'unreadable', message: skill.error }] }
            : gate(
                {
                  name: skill.name,
                  description: skill.description ?? '',
                  whenToUse: skill.whenToUse ?? undefined,
                  body: skill.body ?? '',
                },
                { existingNames: [], allowReplace: true },
              );
          return {
            name: skill.name,
            path: skill.path,
            passesGate: verdict.ok,
            violations: verdict.violations,
            ...(schedule.ok
              ? {
                  stage: schedule.stage,
                  adopted: schedule.adopted === true,
                  reviewCount: schedule.reviewCount,
                  intervalDays: schedule.intervalDays,
                  action: schedule.action,
                  dueAt: schedule.dueAt,
                  overdueDays: schedule.overdueDays,
                  due: schedule.due,
                  retireSuggested: schedule.retireSuggested,
                  suspect: schedule.suspect,
                }
              : { scheduleError: schedule.reason }),
            verification: skill.body ? extractVerificationCommand(skill.body) : null,
          };
        });

        const filtered = args.dueOnly === true ? results.filter((result) => result.due === true) : results;
        filtered.sort((left, right) => (right.overdueDays ?? 0) - (left.overdueDays ?? 0));

        return {
          title: '兰台·校',
          root,
          checked: results.length,
          due: results.filter((result) => result.due === true).length,
          failing: results.filter((result) => result.passesGate === false).length,
          retireSuggested: results.filter((result) => result.retireSuggested === true).map((result) => result.name),
          ladder: INTERVALS,
          results: filtered,
        };
      },
    },
    {
      name: 'skill_attest',
      description:
        '兰台·勘 — 核对完一条 skill 后盖章：记下 reviewedAt、复核等级 +1、复核次数 +1，下一次复核的间隔因此自动拉长（7→14→30→60→90→180 天）。它只记录"我已核对过"，不代为执行验证命令；正文已经过不了闸门时会拒绝盖章并说明原因。',
      parameters: attestParameters,
      output: { schema: OUTPUT, render: (_args, value) => text(value) },
      async execute(args) {
        assertReady();
        requireValid(attestParameters, args);
        const name = args.name.trim();
        const file = await findSkillFile(root, name);
        if (file === null) {
          throw new ToolError(`没有名为 "${name}" 的 skill`, { hint: '先用 skill_catalog 看看有哪些' });
        }

        const skills = await listSkills(root);
        const skill = skills.find((entry) => entry.name === name);
        if (!skill) throw new ToolError(`无法读取 "${name}"`);
        if (skill.error) throw new ToolError(`"${name}" 读不出来：${skill.error}`);

        const verdict = gate(
          {
            name: skill.name,
            description: skill.description ?? '',
            whenToUse: skill.whenToUse ?? undefined,
            body: skill.body ?? '',
          },
          { existingNames: [], allowReplace: true },
        );
        if (!verdict.ok) {
          throw new ToolError(`"${name}" 已经过不了闸门，拒绝盖章：\n${describeViolations(verdict.violations)}`, {
            hint: '先修正正文（或重新蒸馏），再核对盖章',
            violations: verdict.violations,
          });
        }

        const clock = now();
        const stage = nextStage(skill.stage);
        const reviewCount = skill.reviewCount + 1;
        const stamped = await attestSkill(root, name, {
          now: clock,
          stage,
          reviewCount,
          note: typeof args.note === 'string' ? args.note : undefined,
        });

        return {
          title: '兰台·勘',
          name,
          path: stamped.path,
          reviewedAt: stamped.reviewedAt,
          stage,
          reviewCount,
          nextIntervalDays: INTERVALS[stage],
          nextReviewAt: new Date(clock.getTime() + INTERVALS[stage] * DAY_MS).toISOString(),
          backup: stamped.backup,
        };
      },
    },
    {
      name: 'skill_retire',
      description:
        '兰台·削 — 归档一条不再有用的 skill：先通过会话的确认通道向你出示一张卡片（写明归档谁、归档到哪、可恢复），得到允许后才把它移到 skills.retired 下并返回归档路径。没有任何文件被真正删除；不确认就什么都不做。',
      parameters: retireParameters,
      output: { schema: OUTPUT, render: (_args, value) => text(value) },
      presentCall: (args) => ({
        card: 'generic',
        title: '兰台·削',
        kind: 'other',
        rawInput: { name: args.name, reason: args.reason },
      }),
      async execute(args, exec) {
        assertReady();
        requireValid(retireParameters, args);
        const name = args.name.trim();
        const file = await findSkillFile(root, name);
        if (file === null) {
          throw new ToolError(`没有名为 "${name}" 的 skill`, { hint: '先用 skill_catalog 看看有哪些' });
        }
        const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
        if (reason.length < 3) {
          throw new ToolError('必须说明归档原因', { hint: '写清它为什么不再有用；原因会进入确认卡片和归档记录' });
        }
        if (path.resolve(file).startsWith(`${path.resolve(root)}${path.sep}`) === false) {
          throw new ToolError(`"${name}" 不在 ${root} 之内，兰台只归档这个目录下的条目`, {
            hint: '内置 skill 装在 app.asar 里，只读，删不掉；忽略它即可',
          });
        }
        if (typeof requestApproval !== 'function' || !(exec && exec.agent)) {
          throw new ToolError('当前会话没有可用的确认通道，拒绝归档', {
            hint: '归档必须由你当场同意；没有交互会话时兰台不会替你做这个决定',
          });
        }

        const request = {
          agent: exec.agent,
          toolName: 'skill_retire',
          reason: `skill_retire「${name}」：${reason}；移到 ${root}.retired（只移不删，可随时搬回）`,
          displayReason: `兰台·削：归档「${name}」—— ${reason}`,
        };
        if (exec.callId !== undefined) request.callId = exec.callId;
        if (exec.signal !== undefined) request.signal = exec.signal;

        const outcome = await requestApproval(request);
        if (outcome !== 'allowed-once') {
          return {
            title: '兰台·削',
            name,
            archived: false,
            outcome,
            note: '没有得到允许，未做任何改动',
          };
        }

        const archived = await archiveSkill(root, name, { now: now(), reason });
        return {
          title: '兰台·削',
          name,
          archived: true,
          outcome,
          reason,
          archivedTo: archived.archivedTo,
          record: archived.record,
          note: '已移到归档目录，没有删除任何内容；需要时把它搬回 skill 根目录即可。',
        };
      },
    },
  ];
}
