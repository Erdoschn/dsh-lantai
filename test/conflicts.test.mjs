/**
 * Conflict detection.
 *
 * The cases below are all deterministic: an option set to two values, a command one
 * skill prescribes while the other forbids, two skills claiming the same trigger with
 * different verification, a path that one skill says exists and another says is gone.
 * If a rule ever needs judgement, it does not belong here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareSkills,
  detectConflicts,
  extractCommands,
  extractOptions,
  extractPaths,
  extractSnippets,
  triggerSimilarity,
} from '../lib/conflicts.js';

const skill = (over) => ({
  name: 'skill-a',
  description: '在 Windows 上用 git 经 HTTPS 访问 GitHub 时绕过 schannel 凭据错误。',
  whenToUse: '当 git 报 SEC_E_NO_CREDENTIALS 时。',
  body: '',
  ...over,
});

const BODY_TLS_OPENSSL = `## 现象
报 SEC_E_NO_CREDENTIALS。

## 做法
加 \`-c http.sslBackend=openssl\` 再试。

## 验证
\`git -c http.sslBackend=openssl ls-remote origin\` 返回 ref 列表。

## 边界
只适用于 git for Windows。`;

const BODY_TLS_SCHANNEL = `## 现象
报 SEC_E_NO_CREDENTIALS。

## 做法
保持 \`-c http.sslBackend=schannel\` 不要改动。

## 验证
\`git -c http.sslBackend=schannel ls-remote origin\` 返回 ref 列表。

## 边界
只适用于企业代理环境。`;

test('snippets are extracted from fenced blocks and inline spans', () => {
  const snippets = extractSnippets('用 `npm test` 跑，或者：\n```bash\ngit status\n```\n');
  assert.ok(snippets.includes('npm test'));
  assert.ok(snippets.some((snippet) => snippet.includes('git status')));
});

test('options are extracted from key=value and long flags', () => {
  const options = extractOptions(['git -c http.sslBackend=openssl push --force']);
  assert.deepEqual([...options.get('http.sslbackend')], ['openssl']);
  assert.deepEqual([...options.get('--force')], ['true']);
});

test('commands and paths are extracted conservatively', () => {
  const commands = extractCommands(['git push origin main', 'pnpm add x']);
  assert.deepEqual([...commands.keys()].sort(), ['git', 'pnpm']);
  const paths = extractPaths(['写入 ~/.dsh/secrets/token 即可', '还有 D:\\Work\\x']);
  assert.ok([...paths].some((path) => path.endsWith('token')));
  assert.ok([...paths].some((path) => path.startsWith('D:')));
});

test('the same option with different values is a high-severity conflict', () => {
  const conflicts = compareSkills(skill({ body: BODY_TLS_OPENSSL }), skill({ name: 'skill-b', body: BODY_TLS_SCHANNEL }));
  const found = conflicts.find((conflict) => conflict.kind === 'option-value');
  assert.ok(found, 'option-value conflict must be reported');
  assert.equal(found.severity, 'high');
  assert.ok(found.evidence.some((line) => line.includes('http.sslbackend')));
  assert.match(found.suggestion, /归档另一条|改写它的边界节/);
});

test('a command prescribed by one and forbidden by the other is reported', () => {
  const a = skill({
    body: `## 做法
\`git push --force\` 覆盖远端。

## 验证
\`git status\` 干净。

## 边界
无。`,
  });
  const b = skill({
    name: 'skill-b',
    body: `## 做法
先拉取再推。

## 验证
\`git status\` 干净。

## 边界
\`git push --force\` 不要用，会丢别人的提交。`,
  });
  const conflicts = compareSkills(a, b);
  const found = conflicts.find((conflict) => conflict.kind === 'command-contrast');
  assert.ok(found, 'command-contrast must be reported');
  assert.equal(found.severity, 'high', 'a caveat in the boundaries section is a real contradiction');
  assert.ok(found.evidence.some((line) => line.includes('--force')));
});

test('the same trigger with different verification is reported as competing cures', () => {
  const conflicts = compareSkills(skill({ body: BODY_TLS_OPENSSL }), skill({ name: 'skill-b', body: BODY_TLS_SCHANNEL }));
  assert.ok(conflicts.some((conflict) => conflict.kind === 'competing-cure'));
});

test('a path that one skill says exists and another says is gone is reported', () => {
  const a = skill({
    body: `## 做法
token 放在 \`~/.dsh/secrets/token\`。

## 验证
\`ls ~/.dsh/secrets/token\` 有输出。

## 边界
无。`,
  });
  const b = skill({
    name: 'skill-b',
    body: `## 做法
新的凭据位置在别处。

## 验证
\`ls ~/.cfgu\` 失败。

## 边界
\`~/.dsh/secrets/token\` 已删除，不要再用。`,
  });
  const conflicts = compareSkills(a, b);
  const found = conflicts.find((conflict) => conflict.kind === 'path-existence');
  assert.ok(found, 'path-existence must be reported');
  assert.match(found.suggestion, /迁移之前/);
});

test('two unrelated skills produce no conflict', () => {
  const a = skill({ body: BODY_TLS_OPENSSL });
  const b = skill({
    name: 'office-docx',
    description: '创建、读取、编辑 Word 文档。',
    whenToUse: '当需要生成报告或信函时。',
    body: `## 做法
用 \`python-docx\` 打开文档。

## 验证
\`python -c "import docx"\` 不报错。

## 边界
不处理旧版 \`.doc\`。`,
  });
  assert.deepEqual(compareSkills(a, b), []);
});

test('trigger similarity is a token comparison, not a guess', () => {
  const high = triggerSimilarity(
    skill({ whenToUse: '当 git 报 SEC_E_NO_CREDENTIALS 时。' }),
    skill({ whenToUse: '当 git 报 SEC_E_NO_CREDENTIALS 时。' }),
  );
  assert.equal(high, 1);
  const low = triggerSimilarity(
    skill({ whenToUse: '当 git 报错时。', description: 'git 凭据' }),
    skill({ name: 'x', whenToUse: '当要生成 Word 报告时。', description: 'office docx 报告' }),
  );
  assert.ok(low < 0.34);
});

test('detectConflicts walks every pair and skips unreadable skills', () => {
  const a = skill({ body: BODY_TLS_OPENSSL });
  const b = skill({ name: 'skill-b', body: BODY_TLS_SCHANNEL });
  const broken = { name: 'broken', error: 'unreadable' };
  const conflicts = detectConflicts([a, b, broken]);
  assert.ok(conflicts.length > 0);
  assert.ok(conflicts.every((conflict) => conflict.a !== 'broken' && conflict.b !== 'broken'));
});

test('identical skills do not conflict with themselves', () => {
  assert.deepEqual(compareSkills(skill({ body: BODY_TLS_OPENSSL }), skill({ body: BODY_TLS_OPENSSL })), []);
});
