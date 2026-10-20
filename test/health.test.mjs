import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildTools } from '../lib/tools.js';

const BODY = (cmd) => `## 做法
用 \`${cmd}\` 执行。

## 验证
\`${cmd} --check\` 返回 0。

## 边界
只在这些条件下适用。`;

async function dirWith(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lantai-health-'));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.join(root, name), { recursive: true });
    await writeFile(path.join(root, name, 'SKILL.md'), content, 'utf8');
  }
  return root;
}

const frontmatter = (name, description, body, extra = '') =>
  `---\nname: "${name}"\ndescription: "${description}"\nmetadata:\n  source: "lantai"\n${extra}---\n\n${body}\n`;

function toolsFor(root, now = () => new Date('2026-10-20T00:00:00Z')) {
  const tools = buildTools({ config: { skillRoot: root, allowReplace: false }, askUser: undefined, now });
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

test('a clean collection reports nothing to fix', async () => {
  const root = await dirWith({
    'git-auth': frontmatter('git-auth', '在 Windows 上用 git 访问 GitHub', BODY('git push'), '  distilledAt: "2026-10-19T00:00:00Z"\n  stage: "0"\n'),
    'powershell-write': frontmatter('powershell-write', '在 Windows 上写 UTF-8 文件', BODY('WriteAllText'), '  distilledAt: "2026-10-19T00:00:00Z"\n  stage: "0"\n'),
  });
  const { skill_health } = toolsFor(root);
  const report = await skill_health.execute({});
  assert.equal(report.skills, 2);
  // Two skills under one theme is *correctly* reported as thin coverage: it is a
  // knowledge gap, not a defect. What must not appear is anything high/medium.
  assert.equal(report.high, 0);
  assert.equal(report.medium, 0);
  assert.ok(report.findings.every((finding) => finding.kind === 'thin-coverage'));
});

test('an imported skill with no verification is flagged', async () => {
  const root = await dirWith({
    'imported-thin': '---\nname: "imported-thin"\ndescription: "一条从别处导入、没有验证方式的 skill"\n---\n\n就一句话。\n',
  });
  const { skill_health } = toolsFor(root);
  const report = await skill_health.execute({});
  const codes = report.findings.map((finding) => finding.message);
  assert.ok(codes.some((message) => message.includes('过不了闸门')));
  const failFinding = report.findings.find((finding) => finding.message.includes('过不了闸门'));
  assert.ok(failFinding.evidence.some((line) => line.includes('missing-verification')));
});

test('orphans are reported with an action', async () => {
  const root = await dirWith({
    'git-auth': frontmatter('git-auth', '在 Windows 上用 git 访问 GitHub', BODY('git push'), '  distilledAt: "2026-10-19T00:00:00Z"\n  stage: "0"\n'),
    'powershell-write': frontmatter('powershell-write', '在 Windows 上写 UTF-8 文件', BODY('WriteAllText'), '  distilledAt: "2026-10-19T00:00:00Z"\n  stage: "0"\n'),
    'bread-oven': frontmatter('bread-oven', '关于烘焙面包的温度控制', BODY('oven 180'), '  distilledAt: "2026-10-19T00:00:00Z"\n  stage: "0"\n'),
  });
  const { skill_health } = toolsFor(root);
  const report = await skill_health.execute({});
  const orphan = report.findings.find((finding) => finding.kind === 'orphan');
  assert.ok(orphan, 'the unrelated skill must be flagged as an island');
  assert.match(orphan.action, /归档/);
});

test('an overdue review is flagged with the instruction to run its verification', async () => {
  const root = await dirWith({
    'stale-one': frontmatter('stale-one', '在 Windows 上用 git 访问 GitHub', BODY('git push'), '  distilledAt: "2020-01-01T00:00:00Z"\n  stage: "0"\n'),
    'powershell-write': frontmatter('powershell-write', '在 Windows 上写 UTF-8 文件', BODY('WriteAllText'), '  distilledAt: "2026-10-19T00:00:00Z"\n  stage: "0"\n'),
  });
  const { skill_health } = toolsFor(root);
  const report = await skill_health.execute({});
  const due = report.findings.find((finding) => finding.kind === 'due-review');
  assert.ok(due, 'a 2020 skill must be overdue');
  assert.equal(due.severity, 'high');
  assert.match(due.action, /skill_attest|归档/);
});

test('conflicts are surfaced by the health report', async () => {
  const root = await dirWith({
    'use-openssl': frontmatter(
      'use-openssl',
      '在 Windows 上用 git 经 HTTPS 访问 GitHub',
      '做法：`git -c http.sslBackend=openssl push`。\n\n验证：`git -c http.sslBackend=openssl ls-remote`。\n\n边界：无。',
      '  distilledAt: "2026-10-19T00:00:00Z"\n  stage: "0"\n',
    ),
    'keep-schannel': frontmatter(
      'keep-schannel',
      '在 Windows 上用 git 经 HTTPS 访问 GitHub',
      '做法：`git -c http.sslBackend=schannel push`。\n\n验证：`git -c http.sslBackend=schannel ls-remote`。\n\n边界：无。',
      '  distilledAt: "2026-10-19T00:00:00Z"\n  stage: "0"\n',
    ),
  });
  const { skill_health } = toolsFor(root);
  const report = await skill_health.execute({});
  assert.ok(report.findings.some((finding) => finding.kind === 'option-value'));
});

test('the brief format gives a headline and three items', async () => {
  const root = await dirWith({
    'a-thin': '---\nname: "a-thin"\ndescription: "一条没有验证方式的 skill，用来触发体检报告"\n---\n\n就一句话。\n',
  });
  const { skill_health } = toolsFor(root);
  const brief = await skill_health.execute({ format: 'brief' });
  assert.match(brief.headline, /1 条 skill/);
  assert.ok(brief.top.length <= 3);
});

test('an empty directory is not an error', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lantai-health-empty-'));
  const { skill_health } = toolsFor(root);
  const report = await skill_health.execute({});
  assert.equal(report.skills, 0);
  assert.equal(report.findings.length, 0);
});

test('findings are ordered by severity', async () => {
  const root = await dirWith({
    'stale-one': frontmatter('stale-one', '在 Windows 上用 git 访问 GitHub', BODY('git push'), '  distilledAt: "2020-01-01T00:00:00Z"\n  stage: "0"\n'),
    'imported-thin': '---\nname: "imported-thin"\ndescription: "一条从别处导入、没有验证方式的 skill"\n---\n\n就一句话。\n',
  });
  const { skill_health } = toolsFor(root);
  const report = await skill_health.execute({});
  const order = { high: 0, medium: 1, low: 2 };
  for (let i = 1; i < report.findings.length; i += 1) {
    assert.ok(
      order[report.findings[i - 1].severity] <= order[report.findings[i].severity],
      'findings must be sorted most severe first',
    );
  }
});
