import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
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
  name: 'temp-skill-under-test',
  description: '一条用于验证归档流程的 skill，测试结束后应当被移到归档目录而不是被删除。',
  body: VALID_BODY,
};

const REASON = '已经被更好的做法取代，留着会误导';
const EXEC = { agent: { session: { id: 'session-under-test' } }, callId: 'call-under-test' };

/**
 * `requestApproval(request)` bridges to `ctx.approval.request()`, the channel that
 * actually reaches the user from a root-level plugin. Only `allowed-once` is a grant.
 */
async function harness(outcome) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lantai-retire-'));
  const asked = [];
  const requestApproval = async (request) => {
    asked.push(request);
    return typeof outcome === 'function' ? outcome(request) : outcome;
  };
  const tools = buildTools({ config: { skillRoot: root, allowReplace: false }, requestApproval });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  await byName.skill_distill.execute(DRAFT);
  return { root, byName, asked };
}

test('a reason is mandatory: retiring without one is refused', async () => {
  const { root, byName, asked } = await harness('allowed-once');
  await assert.rejects(byName.skill_retire.execute({ name: DRAFT.name }, EXEC), /reason|必须说明归档原因/);
  assert.equal(asked.length, 0, 'no reason, no request, no ask');
  assert.ok((await stat(path.join(root, DRAFT.name, 'SKILL.md'))).isFile());
});

test('the reason reaches the confirmation card', async () => {
  const { byName, asked } = await harness('cancelled');
  await byName.skill_retire.execute({ name: DRAFT.name, reason: REASON }, EXEC);

  assert.equal(asked.length, 1);
  const request = asked[0];
  assert.equal(request.agent, EXEC.agent);
  assert.equal(request.toolName, 'skill_retire');
  assert.equal(request.callId, EXEC.callId);
  assert.match(request.displayReason, /兰台·削/);
  assert.ok(request.displayReason.includes(DRAFT.name));
  assert.ok(request.displayReason.includes(REASON), 'the card must say WHY');
  assert.ok(request.reason.includes(REASON));
  assert.match(request.reason, /只移不删/);
});

test('only allowed-once archives anything', async () => {
  for (const outcome of ['denied', 'cancelled', 'unavailable', undefined, 'allowed']) {
    const { root, byName } = await harness(() => outcome);
    const result = await byName.skill_retire.execute({ name: DRAFT.name, reason: REASON }, EXEC);
    assert.equal(result.archived, false, `outcome ${JSON.stringify(outcome)} must not archive`);
    assert.ok((await stat(path.join(root, DRAFT.name, 'SKILL.md'))).isFile());
  }
});

test('allowed-once archives the bundle, and the archive record explains why', async () => {
  const { root, byName } = await harness('allowed-once');
  const result = await byName.skill_retire.execute({ name: DRAFT.name, reason: REASON }, EXEC);

  assert.equal(result.archived, true);
  assert.equal(result.outcome, 'allowed-once');
  assert.equal(result.reason, REASON);
  assert.ok(result.archivedTo.startsWith(`${root}.retired`));

  assert.deepEqual(await readdir(root), []);
  const archived = await readFile(path.join(result.archivedTo, 'SKILL.md'), 'utf8');
  assert.ok(archived.includes('## 验证'));

  const record = await readFile(path.join(result.archivedTo, 'RETIRED.md'), 'utf8');
  assert.ok(record.includes(DRAFT.name));
  assert.ok(record.includes(REASON), 'the record must carry the reason');
  assert.match(record, /归档时间: \d{4}-\d{2}-\d{2}T/);
  assert.match(record, /恢复方式/);
});

test('an archived skill can be moved back by hand', async () => {
  const { root, byName } = await harness('allowed-once');
  const result = await byName.skill_retire.execute({ name: DRAFT.name, reason: REASON }, EXEC);
  const { cp, rm } = await import('node:fs/promises');
  await cp(result.archivedTo, path.join(root, DRAFT.name), { recursive: true });
  await rm(result.archivedTo, { recursive: true, force: true });
  const catalog = await byName.skill_catalog.execute({});
  assert.equal(catalog.count, 1);
});

test('without an approval channel the tool refuses and asks nobody', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lantai-retire2-'));
  const tools = buildTools({ config: { skillRoot: root, allowReplace: false } });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  await byName.skill_distill.execute(DRAFT);
  await assert.rejects(
    byName.skill_retire.execute({ name: DRAFT.name, reason: REASON }, EXEC),
    /没有可用的确认通道/,
  );
  assert.ok((await stat(path.join(root, DRAFT.name, 'SKILL.md'))).isFile());
});

test('without a live agent the tool refuses instead of asking into the void', async () => {
  const { root, byName, asked } = await harness('allowed-once');
  await assert.rejects(byName.skill_retire.execute({ name: DRAFT.name, reason: REASON }), /没有可用的确认通道/);
  assert.equal(asked.length, 0, 'it must not even try to ask');
  assert.ok((await stat(path.join(root, DRAFT.name, 'SKILL.md'))).isFile());
});

test('a call without a call id still asks, just without the anchor', async () => {
  const { byName, asked } = await harness('cancelled');
  await byName.skill_retire.execute({ name: DRAFT.name, reason: REASON }, { agent: { session: { id: 's2' } } });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].callId, undefined);
});

test('retiring an unknown skill explains itself', async () => {
  const { byName } = await harness('allowed-once');
  await assert.rejects(byName.skill_retire.execute({ name: 'nope', reason: REASON }, EXEC), /没有名为 "nope"/);
});

test('the tool declares a presentable card', async () => {
  const { byName } = await harness('cancelled');
  const tool = byName.skill_retire;
  assert.equal(typeof tool.presentCall, 'function');
  const card = tool.presentCall({ name: DRAFT.name, reason: REASON });
  assert.equal(card.title, '兰台·削');
  assert.equal(card.card, 'generic');
  assert.equal(card.rawInput.name, DRAFT.name);
  assert.equal(card.rawInput.reason, REASON);
});
