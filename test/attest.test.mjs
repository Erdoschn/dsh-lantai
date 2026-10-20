import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildTools } from '../lib/tools.js';

const VALID_BODY = `## 现象
在 Windows 上 \`git ls-remote\` 报 SEC_E_NO_CREDENTIALS。

## 做法
加 \`-c http.sslBackend=openssl\` 再试。

## 验证
\`git -c http.sslBackend=openssl ls-remote origin\` 返回 ref 列表。

## 边界
只适用于 git for Windows 的 schannel 后端。`;

const DRAFT = {
  name: 'git-https-auth-on-windows',
  description: '在 Windows 上用 git 通过 HTTPS 访问 GitHub 时，绕过 schannel 凭据错误并安全地使用 token。',
  body: VALID_BODY,
};

async function harness(nowIso = '2026-10-19T00:00:00Z') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lantai-attest-'));
  let clock = new Date(nowIso);
  const tools = buildTools({ config: { skillRoot: root, allowReplace: false }, now: () => clock });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return {
    root,
    byName,
    advanceDays(days) {
      clock = new Date(clock.getTime() + days * 86400000);
    },
  };
}

test('a fresh skill starts at stage 0 and is reviewed in 7 days', async () => {
  const { byName } = await harness();
  const written = await byName.skill_distill.execute(DRAFT);
  assert.equal(written.stage, 0);
  assert.equal(written.nextReviewAt, '2026-10-26T00:00:00.000Z');

  const audit = await byName.skill_audit.execute({});
  assert.equal(audit.results[0].stage, 0);
  assert.equal(audit.results[0].intervalDays, 7);
  assert.equal(audit.results[0].due, false);
});

test('attest stamps the file and stretches the interval to 14 days', async () => {
  const { byName, advanceDays, root } = await harness();
  await byName.skill_distill.execute(DRAFT);
  advanceDays(8);

  const due = await byName.skill_audit.execute({ dueOnly: true });
  assert.equal(due.results.length, 1);
  assert.equal(due.results[0].overdueDays, 1);

  const stamped = await byName.skill_attest.execute({ name: DRAFT.name, note: '仍然可用' });
  assert.equal(stamped.stage, 1);
  assert.equal(stamped.reviewCount, 1);
  assert.equal(stamped.nextIntervalDays, 14);
  assert.equal(stamped.nextReviewAt, '2026-11-10T00:00:00.000Z');

  const text = await readFile(path.join(root, DRAFT.name, 'SKILL.md'), 'utf8');
  assert.match(text, /reviewedAt: "2026-10-27T00:00:00.000Z"/);
  assert.match(text, /stage: "1"/);
  assert.match(text, /reviewCount: "1"/);
  assert.match(text, /reviewNote: "仍然可用"/);
  // The body must survive a round trip through the stamping.
  assert.ok(text.includes('## 验证'));
});

test('after stamping, the skill is no longer due — it is not reset to 7 days', async () => {
  const { byName, advanceDays } = await harness();
  await byName.skill_distill.execute(DRAFT);
  advanceDays(8);
  await byName.skill_attest.execute({ name: DRAFT.name });

  advanceDays(3); // day 11 overall: 3 days after the review, inside the 14-day window
  const audit = await byName.skill_audit.execute({});
  assert.equal(audit.results[0].stage, 1);
  assert.equal(audit.results[0].intervalDays, 14);
  assert.equal(audit.results[0].due, false);
});

test('attest refuses a skill whose body no longer passes the gate', async () => {
  const { root, byName } = await harness();
  await mkdir(path.join(root, 'broken'), { recursive: true });
  await writeFile(
    path.join(root, 'broken', 'SKILL.md'),
    '---\nname: "broken"\ndescription: "一条已经烂掉的 skill，用来验证盖章会被拒绝"\n---\n\n就一句话。\n',
    'utf8',
  );
  await assert.rejects(byName.skill_attest.execute({ name: 'broken' }), /拒绝盖章/);
});

test('attest on an unknown name explains itself', async () => {
  const { byName } = await harness();
  await assert.rejects(byName.skill_attest.execute({ name: 'nope' }), /没有名为 "nope"/);
});

test('catalog exposes the review schedule too', async () => {
  const { byName, advanceDays } = await harness();
  await byName.skill_distill.execute(DRAFT);
  advanceDays(30);
  const catalog = await byName.skill_catalog.execute({});
  assert.equal(catalog.skills[0].stage, 0);
  assert.equal(catalog.skills[0].due, true);
  assert.equal(catalog.skills[0].reviewCount, 0);
});

test('a hand-written skill is adopted using its file mtime instead of being ignored', async () => {
  const { root, byName } = await harness();
  await mkdir(path.join(root, 'hand-written'), { recursive: true });
  await writeFile(
    path.join(root, 'hand-written', 'SKILL.md'),
    `---\nname: "hand-written"\ndescription: "a skill somebody wrote by hand, with no metadata block at all"\n---\n\n${VALID_BODY}\n`,
    'utf8',
  );

  const audit = await byName.skill_audit.execute({});
  const entry = audit.results.find((result) => result.name === 'hand-written');
  assert.equal(entry.adopted, true, 'a skill without distilledAt must be adopted via mtime');
  assert.ok(entry.dueAt, 'it must still get a schedule');
  assert.equal(entry.stage, 0);
  assert.equal(entry.intervalDays, 7);
  assert.equal(entry.passesGate, true);
});
