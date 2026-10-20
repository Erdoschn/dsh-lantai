import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DANGEROUS_PATTERNS, gate, extractVerificationCommand, validateBody } from '../lib/rules.js';

const VALID_BODY = `## 现象
在 Windows 上 \`git ls-remote\` 报 SEC_E_NO_CREDENTIALS。

## 做法
加 \`-c http.sslBackend=openssl\` 再试。

## 验证
\`git -c http.sslBackend=openssl ls-remote origin\` 返回 ref 列表。

## 边界
只适用于 git for Windows 的 schannel 后端。`;

const validDraft = () => ({
  name: 'git-https-auth-on-windows',
  description: '在 Windows 上用 git 通过 HTTPS 访问 GitHub 时，绕过 schannel 凭据错误并安全地使用 token。',
  whenToUse: '当 git 报 SEC_E_NO_CREDENTIALS 或推送被拒时。',
  body: VALID_BODY,
});

test('a well-formed draft passes', () => {
  const verdict = gate(validDraft());
  assert.deepEqual(verdict.violations, []);
  assert.equal(verdict.ok, true);
});

test('names must be kebab-case', () => {
  for (const name of ['Git_Auth', 'has space', '两个汉字', '-leading', 'trailing-']) {
    const verdict = gate({ ...validDraft(), name });
    assert.equal(verdict.ok, false, `${name} should be rejected`);
    assert.ok(verdict.violations.some((violation) => violation.code === 'name-not-kebab'));
  }
});

test('descriptions must be specific enough to choose by', () => {
  assert.ok(gate({ ...validDraft(), description: 'git 技巧' }).violations.some((v) => v.code === 'description-too-short'));
  assert.ok(
    gate({ ...validDraft(), description: 'x'.repeat(300) }).violations.some((v) => v.code === 'description-too-long'),
  );
});

test('a body without a verification section is rejected', () => {
  const body = VALID_BODY.replace('## 验证', '## 其他');
  const violations = validateBody(body);
  assert.ok(violations.some((violation) => violation.code === 'missing-verification'));
});

test('a verification section without a command is rejected', () => {
  const body = VALID_BODY.replace(
    '`git -c http.sslBackend=openssl ls-remote origin` 返回 ref 列表。',
    '总之能用了。',
  );
  const violations = validateBody(body);
  assert.ok(violations.some((violation) => violation.code === 'verification-without-command'));
});

test('a body without a boundaries section is rejected', () => {
  const body = VALID_BODY.replace('## 边界', '## 备注');
  assert.ok(validateBody(body).some((violation) => violation.code === 'missing-boundaries'));
});

test('vague advice with no concrete tokens is rejected', () => {
  const body = `## 现象
经常出问题。

## 做法
要小心一点，多检查几遍再提交。

## 验证
自己能感觉到。

## 边界
到处都是。`;
  assert.ok(validateBody(body).some((violation) => violation.code === 'not-concrete'));
});

test('placeholder text is rejected', () => {
  assert.ok(validateBody(`${VALID_BODY}\nTODO: 补一段`).some((violation) => violation.code === 'body-placeholder'));
});

test('every dangerous pattern is actually enforced', () => {
  const snippets = {
    'escalate-sandbox': '用 danger-full-access 跑这条命令即可。',
    'disable-guardrail': '关闭沙箱之后再执行。',
    'token-in-url': 'clone https://x-access-token@github.com/acme/api.git',
    'literal-token': '导出 token ghp_abcdefghijklmnopqrstuvwx 备用。',
    'force-push': 'git push --force 覆盖远端。',
    'push-to-default-branch': 'git push origin main 直接生效。',
    'admin-scope': '需要一个 admin 权限的 token。',
    'skip-verification': '无需验证，直接提交。',
  };
  for (const rule of DANGEROUS_PATTERNS) {
    const snippet = snippets[rule.code];
    assert.ok(snippet, `no fixture for rule ${rule.code}`);
    const verdict = gate({ ...validDraft(), body: `${VALID_BODY}\n${snippet}` });
    assert.equal(verdict.ok, false, `rule ${rule.code} did not fire`);
    assert.ok(
      verdict.violations.some((violation) => violation.code === rule.code),
      `rule ${rule.code} missing from ${JSON.stringify(verdict.violations.map((v) => v.code))}`,
    );
  }
});

test('duplicates are rejected unless replacement is explicit', () => {
  const existingNames = [validDraft().name];
  assert.ok(gate(validDraft(), { existingNames }).violations.some((v) => v.code === 'duplicate'));
  assert.equal(gate(validDraft(), { existingNames, allowReplace: true }).ok, true);
});

test('the verification command is extractable for the audit', () => {
  assert.equal(
    extractVerificationCommand(VALID_BODY),
    'git -c http.sslBackend=openssl ls-remote origin',
  );
});

test('body length is bounded', () => {
  const long = `${VALID_BODY}\n${Array.from({ length: 200 }, (_, index) => `第 ${index} 行补充说明。`).join('\n')}`;
  assert.ok(validateBody(long).some((violation) => violation.code === 'body-too-long'));
});
