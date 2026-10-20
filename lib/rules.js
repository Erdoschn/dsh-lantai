/**
 * 兰台 · the gate.
 *
 * Every rule here exists because of an observed failure, not because it looked
 * tidy. Three kinds:
 *   1. shape      — a skill the harness will actually discover and load
 *   2. substance  — a skill that says something checkable instead of vague advice
 *   3. safety     — a skill that cannot become a standing instruction to escalate
 *
 * Rules are pure functions returning violations. Nothing here writes files.
 */
export const LIMITS = {
  minBodyLines: 6,
  maxBodyLines: 150,
  maxBodyChars: 8000,
  minDescription: 20,
  maxDescription: 220,
  maxWhenToUse: 220,
  namePattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  maxNameLength: 48,
};

/**
 * Patterns that turn a skill into a standing permission grant. A skill is loaded
 * into every future session that matches its trigger, so a dangerous sentence here
 * is worse than a dangerous sentence in a chat message: nobody re-reads it.
 */
export const DANGEROUS_PATTERNS = [
  {
    code: 'escalate-sandbox',
    pattern: /danger[-_ ]?full[-_ ]?access/i,
    message: '不能建议使用 danger-full-access 提权；改为"向用户申请，或把目标移到工作区内"',
  },
  {
    code: 'disable-guardrail',
    pattern: /(关闭|禁用|关掉|跳过|绕过)[^\n]{0,8}(沙箱|审批|权限确认|确认)|disable[^\n]{0,12}(sandbox|approval)/i,
    message: '不能建议关闭或绕过沙箱与审批',
  },
  {
    code: 'token-in-url',
    pattern: /https?:\/\/[^\s"'`]*@github\.com/i,
    message: '不能把凭据拼进 URL；改为运行时从凭据解析，并只在 header 中使用',
  },
  {
    code: 'literal-token',
    pattern: /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/,
    message: '正文里出现了疑似真实 token；一律用占位符或从凭据读取',
  },
  {
    code: 'force-push',
    pattern: /git\s+push[^\n]*(?:--force\b|\s-f\b)/i,
    message: '不能建议强推；改为在分支上追加提交',
  },
  {
    code: 'push-to-default-branch',
    pattern: /git\s+push[^\n]*\b(?:main|master)\b/i,
    message: '不能建议直推默认分支；改为推送分支后开 PR',
  },
  {
    code: 'admin-scope',
    pattern: /(admin|管理员)[^\n]{0,12}(权限|scope|token)/i,
    message: '不能建议管理员级凭据；按最小 scope 授权',
  },
  {
    code: 'skip-verification',
    pattern: /(无需|不用|不必|跳过)[^\n]{0,6}(验证|核对|审查)/i,
    message: '不能建议跳过验证，这正是本工具要杜绝的行为',
  },
];

const VERIFICATION_HEADING = /^#{1,6}\s*(验证|如何验证|核对|自检|verification|verify)/im;
const BOUNDARY_HEADING = /^#{1,6}\s*(边界|界限|何时停下|不适用|注意边界|boundaries|limits)/im;
const BACKTICK_SPAN = /`[^`\n]{2,120}`/g;
const FENCED_BLOCK = /```[\s\S]*?```/;
const PLACEHOLDER = /\b(TODO|TBD|待补|待填|fill me)\b/i;

export function validateName(name) {
  const violations = [];
  if (typeof name !== 'string' || name.trim() === '') {
    return [{ code: 'name-missing', message: 'name 不能为空' }];
  }
  const candidate = name.trim();
  if (candidate.length > LIMITS.maxNameLength) {
    violations.push({ code: 'name-too-long', message: `name 超过 ${LIMITS.maxNameLength} 字符` });
  }
  if (!LIMITS.namePattern.test(candidate)) {
    violations.push({
      code: 'name-not-kebab',
      message: `name "${candidate}" 必须是 kebab-case（小写字母、数字、连字符），因为它同时是目录名和 skill 标识`,
    });
  }
  return violations;
}

export function validateDescription(description) {
  if (typeof description !== 'string' || description.trim() === '') {
    return [{ code: 'description-missing', message: 'description 不能为空：它是模型决定要不要加载这个 skill 的唯一依据' }];
  }
  const text = description.trim();
  const violations = [];
  if (text.length < LIMITS.minDescription) {
    violations.push({ code: 'description-too-short', message: `description 太短（<${LIMITS.minDescription} 字符），不足以让人判断何时该用` });
  }
  if (text.length > LIMITS.maxDescription) {
    violations.push({ code: 'description-too-long', message: `description 超过 ${LIMITS.maxDescription} 字符，会被目录截断` });
  }
  if (/^[^，,。.；;]{0,6}$/.test(text)) {
    violations.push({ code: 'description-vague', message: 'description 太笼统' });
  }
  return violations;
}

/** @returns {{code: string, message: string}[]} */
export function validateBody(body) {
  const violations = [];
  if (typeof body !== 'string' || body.trim() === '') {
    return [{ code: 'body-missing', message: '正文不能为空' }];
  }
  const lines = body.split('\n');
  if (lines.length < LIMITS.minBodyLines) {
    violations.push({ code: 'body-too-short', message: `正文少于 ${LIMITS.minBodyLines} 行，撑不起一份操作手册` });
  }
  if (lines.length > LIMITS.maxBodyLines) {
    violations.push({ code: 'body-too-long', message: `正文超过 ${LIMITS.maxBodyLines} 行；skill 是操作手册，不是散文` });
  }
  if (body.length > LIMITS.maxBodyChars) {
    violations.push({ code: 'body-too-large', message: `正文超过 ${LIMITS.maxBodyChars} 字符` });
  }
  if (PLACEHOLDER.test(body)) {
    violations.push({ code: 'body-placeholder', message: '正文里还有 TODO / 待补 之类的占位内容' });
  }

  // 1. 必须说清"怎么知道它生效了"
  if (!VERIFICATION_HEADING.test(body)) {
    violations.push({
      code: 'missing-verification',
      message: '缺少「验证 / Verification」小节：没有验证方式的 skill 是谣言，不是经验',
    });
  } else {
    const section = sectionAfter(body, VERIFICATION_HEADING);
    if (!section || (section.match(BACKTICK_SPAN) ?? []).length === 0) {
      violations.push({
        code: 'verification-without-command',
        message: '「验证」小节里至少要有一条用反引号标出的可执行命令或可观察断言',
      });
    }
  }

  // 2. 必须说清"什么情况下它不适用"
  if (!BOUNDARY_HEADING.test(body)) {
    violations.push({
      code: 'missing-boundaries',
      message: '缺少「边界 / 何时停下」小节：一条不说边界的经验，会被当成万能的',
    });
  }

  // 3. 必须具体到能照着做
  const backticks = body.match(BACKTICK_SPAN) ?? [];
  if (backticks.length < 2 && !FENCED_BLOCK.test(body)) {
    violations.push({
      code: 'not-concrete',
      message: '正文里没有具体的命令、路径或字段名；至少要有两个反引号代码片段或一个代码块',
    });
  }

  // 4. 不能是危险的常驻授权
  for (const rule of DANGEROUS_PATTERNS) {
    if (rule.pattern.test(body)) violations.push({ code: rule.code, message: rule.message });
  }

  return violations;
}

/** The text between a heading and the next heading of the same or higher level. */
export function sectionAfter(body, headingPattern) {
  const lines = body.split('\n');
  const index = lines.findIndex((line) => headingPattern.test(line));
  if (index === -1) return null;
  const level = (lines[index].match(/^#+/) ?? ['#'])[0].length;
  const collected = [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const match = lines[cursor].match(/^(#+)\s/);
    if (match && match[1].length <= level) break;
    collected.push(lines[cursor]);
  }
  return collected.join('\n');
}

/** What the audit reports as "run this to check the skill still holds". */
export function extractVerificationCommand(body) {
  const section = sectionAfter(body, VERIFICATION_HEADING);
  if (!section) return null;
  const fenced = section.match(/```[a-z]*\n([\s\S]*?)```/);
  if (fenced) return fenced[1].trim().split('\n')[0].trim();
  const span = section.match(BACKTICK_SPAN);
  return span ? span[0].slice(1, -1) : null;
}

/**
 * The whole gate: shape + substance + safety + uniqueness.
 * @param {{name: string, description: string, whenToUse?: string, body: string}} draft
 * @param {{existingNames?: string[], allowReplace?: boolean}} context
 */
export function gate(draft, { existingNames = [], allowReplace = false } = {}) {
  const violations = [
    ...validateName(draft.name),
    ...validateDescription(draft.description),
    ...validateBody(draft.body),
  ];
  if (typeof draft.whenToUse === 'string' && draft.whenToUse.length > LIMITS.maxWhenToUse) {
    violations.push({ code: 'whenToUse-too-long', message: `whenToUse 超过 ${LIMITS.maxWhenToUse} 字符` });
  }
  const name = typeof draft.name === 'string' ? draft.name.trim() : '';
  if (name !== '' && existingNames.includes(name) && !allowReplace) {
    violations.push({
      code: 'duplicate',
      message: `已存在同名 skill "${name}"；要么换名字，要么显式传 replace: true（旧版会备份成 .bak）`,
    });
  }
  return { ok: violations.length === 0, violations };
}
