/**
 * The graph.
 *
 * The regression this file guards: naive edge inference on the author's own seven
 * skills produced exactly one edge and it was wrong (`node`). The model had to move
 * to two layers — vocabulary themes plus provable structural edges — and these tests
 * pin both the signal and the noise.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildGraph,
  candidateThemes,
  coverage,
  orphans,
  structuralEdges,
  themes,
  toMermaid,
} from '../lib/graph.js';

const skill = (name, over = {}) => ({
  name,
  description: '一条用于测试的 skill，覆盖某个领域。',
  whenToUse: '当需要它时。',
  body: `## 做法
用 \`echo hello\` 打印。

## 验证
\`echo hello\` 输出 hello。

## 边界
无。`,
  ...over,
});

const WINDOWS_A = skill('git-auth', {
  description: '在 Windows 上用 git 经 HTTPS 访问时绕过 schannel 错误。',
  whenToUse: '当 git 报 SEC_E_NO_CREDENTIALS 时。',
  body: `## 做法
用 \`git -c http.sslBackend=openssl push\`。

## 验证
\`git -c http.sslBackend=openssl ls-remote origin\` 返回列表。

## 边界
只限 Windows。`,
});

const WINDOWS_B = skill('powershell-encoding', {
  description: '在 Windows 的 PowerShell 里写 UTF-8 文件。',
  whenToUse: '当重定向写出 UTF-16 时。',
  body: `## 做法
用 \`[IO.File]::WriteAllText\`。

## 验证
\`[IO.File]::ReadAllText\` 读回来是 UTF-8。

## 边界
只限 Windows PowerShell 5.1。`,
});

const PLUGIN_A = skill('dsh-plugin-contract', {
  description: '给 dsh 写插件时避免 parameters 未编译。',
  whenToUse: '当插件一装就崩时。',
  body: `## 做法
用 \`defineTool\` 编译。

## 验证
\`assertSchema\` 通过。

## 边界
仅限 dsh。`,
  session: 'session-42',
});

const PLUGIN_B = skill('dsh-service-access', {
  description: '在 dsh 插件里访问服务只能用 ctx.get。',
  whenToUse: '当插件工具全部消失时。',
  body: `## 做法
用 \`ctx.get('x')\`。

## 验证
\`apply\` 不抛异常。

## 边界
仅限 dsh。`,
  session: 'session-42',
});

test('themes come from the summary and the name, not from body prose', () => {
  const candidates = candidateThemes([PLUGIN_A, PLUGIN_B]).map(([term]) => term);
  assert.ok(candidates.includes('dsh'), 'the name segment must count as a theme source');
  assert.equal(candidates.includes('defineTool'.toLowerCase()), false, 'body-only terms must not become themes');
});

test('generic code words never become themes', () => {
  const candidates = candidateThemes([
    skill('a-get', { description: 'get the value', whenToUse: 'when get fails' }),
    skill('b-get', { description: 'get another value', whenToUse: 'when get works' }),
  ]).map(([term]) => term);
  assert.equal(candidates.includes('get'), false);
});

test('one theme can contain several skills', () => {
  const list = themes([WINDOWS_A, WINDOWS_B]);
  const windows = list.find((theme) => theme.term === 'windows');
  assert.ok(windows, 'windows must be a theme');
  assert.deepEqual(windows.members.sort(), ['git-auth', 'powershell-encoding']);
});

test('a lone skill creates no theme', () => {
  assert.deepEqual(themes([skill('solo', { description: '一个孤立的东西', whenToUse: '当孤立时' })]), []);
});

test('the same distillation session links two skills', () => {
  const edges = structuralEdges([PLUGIN_A, PLUGIN_B]);
  const sameSession = edges.find((edge) => edge.kind === 'same-session');
  assert.ok(sameSession, 'same-session edge must be produced');
  assert.equal(sameSession.evidence[0].includes('session-42'), true);
});

test('sharing a path produces a structural edge', () => {
  const a = skill('a', { body: '写 `~/.dsh/skills/x/SKILL.md` 即可。\n\n`echo ok`\n\n边界：无。' });
  const b = skill('b', { body: '读 `~/.dsh/skills/x/SKILL.md` 得到内容。\n\n`echo ok`\n\n边界：无。' });
  const edges = structuralEdges([a, b]);
  const shared = edges.find((edge) => edge.kind === 'shared-path');
  assert.ok(shared);
  assert.ok(shared.evidence.some((item) => item.includes('SKILL.md')));
});

test('one skill naming another produces a references edge', () => {
  const a = skill('alpha', { body: '先看 `beta` 那条。\n\n`echo ok`\n\n边界：无。' });
  const b = skill('beta', { body: '`echo ok`\n\n边界：无。' });
  const edges = structuralEdges([a, b]);
  assert.ok(edges.some((edge) => edge.kind === 'references' && edge.from === 'alpha' && edge.to === 'beta'));
});

test('a real conflict shows up as an edge', () => {
  const a = skill('use-openssl', {
    description: '在 Windows 上用 git 经 HTTPS 访问 GitHub。',
    whenToUse: '当 git 报 SEC_E_NO_CREDENTIALS 时。',
    body: '做法：`git -c http.sslBackend=openssl push`。\n\n验证：`git -c http.sslBackend=openssl ls-remote` 。\n\n边界：无。',
  });
  const b = skill('keep-schannel', {
    description: '在 Windows 上用 git 经 HTTPS 访问 GitHub。',
    whenToUse: '当 git 报 SEC_E_NO_CREDENTIALS 时。',
    body: '做法：`git -c http.sslBackend=schannel push`。\n\n验证：`git -c http.sslBackend=schannel ls-remote`。\n\n边界：无。',
  });
  const edges = structuralEdges([a, b]);
  assert.ok(edges.some((edge) => edge.kind === 'conflicts'));
});

test('an island is reported when a skill belongs to nothing', () => {
  const lonely = skill('totally-unrelated', {
    description: '关于烘焙面包的温度控制。',
    whenToUse: '当需要烤面包时。',
    body: '做法：`oven 180`。\n\n验证：`oven 180`。\n\n边界：无。',
  });
  const graph = buildGraph([WINDOWS_A, WINDOWS_B, lonely]);
  assert.deepEqual(graph.orphans, ['totally-unrelated']);
});

test('thin coverage is flagged so gaps are visible', () => {
  const list = themes([WINDOWS_A, WINDOWS_B]);
  const report = coverage([WINDOWS_A, WINDOWS_B], list);
  const windows = report.find((entry) => entry.theme === 'windows');
  assert.equal(windows.skills, 2);
  assert.equal(windows.thin, true, 'two skills is the thinnest possible coverage');
});

test('theme membership is not counted as a structural edge', () => {
  const graph = buildGraph([WINDOWS_A, WINDOWS_B]);
  assert.equal(graph.edges.length, 0, 'two skills sharing a theme are not "linked"');
  assert.equal(graph.themeLinks, 2, 'membership is reported separately');
});

test('the mermaid output is syntactically shaped', () => {
  const graph = buildGraph([WINDOWS_A, WINDOWS_B, PLUGIN_A, PLUGIN_B]);
  const mermaid = toMermaid(graph);
  assert.match(mermaid, /^graph LR/);
  assert.ok(mermaid.includes('t_windows'));
  assert.equal(orphans(graph.nodes, graph.themes, graph.edges).length, graph.orphans.length);
});

test('an empty collection produces an empty graph, not an error', () => {
  const graph = buildGraph([]);
  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.themes, []);
  assert.deepEqual(graph.edges, []);
  assert.match(toMermaid(graph), /^graph LR/);
});
