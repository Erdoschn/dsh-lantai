import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
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
  whenToUse: '当 git 报 SEC_E_NO_CREDENTIALS 或推送被拒时。',
  body: VALID_BODY,
};

async function harness({ allowReplace = false, now } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lantai-'));
  const tools = buildTools({ config: { skillRoot: root, allowReplace }, now });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { root, byName };
}

test('distill writes a discoverable bundle and reports the path', async () => {
  const { root, byName } = await harness();
  const result = await byName.skill_distill.execute(DRAFT);
  assert.equal(result.ok, true);
  assert.equal(result.name, DRAFT.name);
  assert.equal(result.path, path.join(root, DRAFT.name, 'SKILL.md'));

  const text = await readFile(result.path, 'utf8');
  assert.ok(text.startsWith('---\nname: "git-https-auth-on-windows"'));
  assert.match(text, /source: "lantai"/);
  assert.match(text, /distilledAt:/);
  assert.ok(text.includes('## 验证'));
  // The body comes back so the current turn can act on it without waiting for the
  // session catalog to refresh.
  assert.equal(result.body, VALID_BODY);
});

test('a rejected draft writes nothing at all', async () => {
  const { root, byName } = await harness();
  const bad = { ...DRAFT, body: `${VALID_BODY}\ngit push origin main 直接生效。` };
  await assert.rejects(byName.skill_distill.execute(bad), /闸门拒收/);
  assert.deepEqual(await readdir(root), []);
});

test('duplicates are refused, and the error names the fix', async () => {
  const { byName } = await harness();
  await byName.skill_distill.execute(DRAFT);
  await assert.rejects(
    byName.skill_distill.execute(DRAFT),
    (error) => /闸门拒收/.test(error.message) && /duplicate/.test(error.message),
  );
});

test('replacement backs up the previous file', async () => {
  const { root, byName } = await harness({ allowReplace: true });
  await byName.skill_distill.execute(DRAFT);
  const updated = { ...DRAFT, body: `${VALID_BODY}\n补充：也可以先试 \`git config --get http.sslBackend\`。` };
  const result = await byName.skill_distill.execute({ ...updated, replace: true });
  assert.ok(result.backup);
  assert.equal(path.basename(result.backup), 'SKILL.md.bak');
  const backup = await readFile(result.backup, 'utf8');
  assert.equal(backup.includes('补充：也可以先试'), false);
});

test('replacement is refused when the plugin config does not allow it', async () => {
  const { byName } = await harness({ allowReplace: false });
  await byName.skill_distill.execute(DRAFT);
  await assert.rejects(byName.skill_distill.execute({ ...DRAFT, replace: true }), /未开放覆盖/);
});

test('catalog lists both bundle and flat shapes', async () => {
  const { root, byName } = await harness();
  await byName.skill_distill.execute(DRAFT);
  await writeFile(
    path.join(root, 'flat-one.md'),
    '---\nname: "flat-one"\ndescription: "a flat skill used to prove both shapes are read"\n---\n\nbody\n',
    'utf8',
  );
  const catalog = await byName.skill_catalog.execute({});
  assert.equal(catalog.count, 2);
  assert.deepEqual(catalog.skills.map((skill) => skill.name).sort(), ['flat-one', DRAFT.name]);
});

test('audit reports the review ladder and the verification command', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lantai-audit-'));
  const staleBody = VALID_BODY;
  await mkdir(path.join(root, 'old-skill'), { recursive: true });
  await writeFile(
    path.join(root, 'old-skill', 'SKILL.md'),
    `---\nname: "old-skill"\ndescription: "an old skill distilled long ago and never re-checked since"\nmetadata:\n  source: "lantai"\n  distilledAt: "2020-01-01T00:00:00.000Z"\n---\n\n${staleBody}\n`,
    'utf8',
  );

  const tools = buildTools({ config: { skillRoot: root, allowReplace: false }, now: () => new Date('2026-10-19T00:00:00Z') });
  const audit = tools.find((tool) => tool.name === 'skill_audit');
  const result = await audit.execute({});
  assert.equal(result.checked, 1);
  assert.equal(result.results[0].passesGate, true);
  assert.equal(result.results[0].stage, 0);
  assert.equal(result.results[0].intervalDays, 7);
  assert.equal(result.results[0].due, true);
  assert.equal(result.results[0].retireSuggested, true);
  assert.equal(result.results[0].verification, 'git -c http.sslBackend=openssl ls-remote origin');
});

test('audit flags a skill that no longer passes the gate', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lantai-audit2-'));
  await mkdir(path.join(root, 'thin'), { recursive: true });
  await writeFile(
    path.join(root, 'thin', 'SKILL.md'),
    '---\nname: "thin"\ndescription: "a skill that lost its verification section"\n---\n\n就一句话。\n',
    'utf8',
  );
  const tools = buildTools({ config: { skillRoot: root, allowReplace: false } });
  const audit = tools.find((tool) => tool.name === 'skill_audit');
  const result = await audit.execute({});
  assert.equal(result.failing, 1);
  const codes = result.results[0].violations.map((violation) => violation.code);
  assert.ok(codes.includes('missing-verification'));
});

test('audit of an unknown name explains itself instead of returning nothing', async () => {
  const { byName } = await harness();
  await assert.rejects(byName.skill_audit.execute({ name: 'nope' }), /没有名为 "nope"/);
});

test('an empty root is not an error', async () => {
  const { byName } = await harness();
  const catalog = await byName.skill_catalog.execute({});
  assert.equal(catalog.count, 0);
  const audit = await byName.skill_audit.execute({});
  assert.equal(audit.checked, 0);
});
