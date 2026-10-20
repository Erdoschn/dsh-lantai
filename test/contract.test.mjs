/**
 * The contract test.
 *
 * Two failures motivated this file:
 *
 * 1. DSH's registry never compiles `parameters`, so a plugin that hands it a raw
 *    spec ships a malformed tool schema to the model and kills the process during
 *    assembly. Every tool is checked here against the harness's own shape rules.
 *
 * 2. Cordis throws on `ctx.<service>` for a service that was not declared in
 *    `inject`. That throw happens inside `apply()` and stops the row from
 *    activating at all — tools silently missing, no tool-level error to see. The
 *    deliberately hostile context below (a Proxy that throws on unknown property
 *    access) exists so that bug can never reach a profile again.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTools } from '../lib/tools.js';
import { collectSchemaViolations, validateArgs } from '../lib/schema.js';
import { apply } from '../lib/index.js';

const config = { skillRoot: '/tmp/lantai-contract', allowReplace: false };
const tools = buildTools({ config });

const TOOL_NAME = /^[a-z][a-z0-9_]*$/;
const EXPECTED_TOOLS = ['skill_distill', 'skill_catalog', 'skill_audit', 'skill_attest', 'skill_retire', 'skill_conflicts', 'skill_graph', 'skill_health'];

test('every tool name is ascii snake_case and not reserved', () => {
  const names = new Set();
  for (const tool of tools) {
    assert.match(tool.name, TOOL_NAME, `bad tool name: ${tool.name}`);
    assert.notEqual(tool.name, 'run_code', 'run_code is reserved by the PTC transport');
    assert.equal(names.has(tool.name), false, `duplicate tool name: ${tool.name}`);
    names.add(tool.name);
  }
});

test('the tool set is exactly what the README promises', () => {
  assert.deepEqual(tools.map((tool) => tool.name), EXPECTED_TOOLS);
});

test('every tool declares a non-trivial description', () => {
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 20, `${tool.name} description too short`);
  }
});

test('parameters are compiled JSON Schema, not the terse spec', () => {
  for (const tool of tools) {
    const parameters = tool.parameters;
    assert.equal(typeof parameters, 'object', `${tool.name}: parameters missing`);
    assert.equal(parameters.type, 'object', `${tool.name}: parameters must be object-rooted`);
    assert.ok('properties' in parameters, `${tool.name}: parameters must declare properties`);

    for (const [name, field] of Object.entries(parameters.properties)) {
      assert.equal(typeof field, 'object', `${tool.name}.${name} must be a schema object`);
      assert.ok('type' in field, `${tool.name}.${name} must declare a type`);
      assert.equal('required' in field, false, `${tool.name}.${name} must not carry the spec-only "required" key`);
    }
    if (parameters.required) {
      assert.ok(Array.isArray(parameters.required), `${tool.name}.required must be an array`);
      for (const name of parameters.required) {
        assert.ok(name in parameters.properties, `${tool.name}.required names unknown property ${name}`);
      }
    }
  }
});

test('parameters and output schemas use only the supported JSON Schema subset', () => {
  for (const tool of tools) {
    assert.deepEqual(collectSchemaViolations(tool.parameters, `${tool.name}.parameters`), []);
    assert.deepEqual(collectSchemaViolations(tool.output.schema, `${tool.name}.output.schema`), []);
  }
});

test('every tool renders text', () => {
  for (const tool of tools) {
    assert.equal(typeof tool.output.render, 'function', `${tool.name} needs output.render`);
    const rendered = tool.output.render({}, { ok: true });
    assert.ok(Array.isArray(rendered) && rendered.length > 0, `${tool.name} render returned nothing`);
    assert.equal(rendered[0].type, 'text');
  }
});

test('registered tools reject unknown arguments', () => {
  const distill = tools.find((tool) => tool.name === 'skill_distill');
  const violations = validateArgs(distill.parameters, { name: 'x', description: 'y', body: 'z', nonsense: 1 });
  assert.ok(violations.some((violation) => violation.includes('unknown argument "nonsense"')));
});

test('registered tools validate argument types', () => {
  const audit = tools.find((tool) => tool.name === 'skill_audit');
  assert.deepEqual(validateArgs(audit.parameters, {}), []);
  assert.deepEqual(validateArgs(audit.parameters, { name: 'ok' }), []);
  assert.ok(validateArgs(audit.parameters, { name: 42 }).length > 0);
});

test('a misconfigured plugin still registers tools that refuse at call time', () => {
  const broken = buildTools({ config, problems: ['"skillRoot" 必须是非空路径字符串'] });
  assert.equal(broken.length, 8);
  return assert.rejects(broken[0].execute({ name: 'a', description: 'b', body: 'c' }), /配置有误/);
});

/* -------------------------------------------------------------------------- */
/* A context that behaves like Cordis: undeclared services throw on access.    */
/* -------------------------------------------------------------------------- */

function cordisLikeCtx({ services = {} } = {}) {
  const registered = [];
  const warnings = [];
  const base = {
    register: undefined,
    get(serviceName) {
      if (Object.hasOwn(services, serviceName)) return services[serviceName];
      throw new Error(`cannot get service "${serviceName}"`);
    },
    tools: {
      register(definition) {
        const output = definition.output;
        assert.ok(output && typeof output.render === 'function', `${definition.name} needs output.render`);
        assert.deepEqual(collectSchemaViolations(output.schema, `${definition.name}.output.schema`), []);
        assert.equal(definition.parameters.type, 'object', `${definition.name} parameters must be object-rooted`);
        registered.push(definition.name);
        return () => {};
      },
    },
  };

  const proxy = new Proxy(base, {
    get(target, property) {
      if (typeof property === 'symbol') return undefined;
      if (property in target) return target[property];
      // This is the exact failure mode that silently disabled the plugin once.
      throw new Error(`cannot get property "${String(property)}" without inject`);
    },
  });

  return { proxy, registered, warnings };
}

test('apply() registers every tool against a Cordis-like context', () => {
  const { proxy, registered } = cordisLikeCtx();
  apply(proxy, { skillRoot: '/tmp/lantai-apply', allowReplace: false });
  assert.deepEqual(registered, EXPECTED_TOOLS);
});

test('apply() never touches an undeclared service property', () => {
  // No `systemPrompt`, no `userQuestions`, no `logger`: every optional lookup must
  // degrade, not throw. A property access would throw through the Proxy above.
  const { proxy, registered } = cordisLikeCtx();
  assert.doesNotThrow(() => apply(proxy, { skillRoot: '/tmp/lantai-apply' }));
  assert.equal(registered.length, EXPECTED_TOOLS.length);
});

test('apply() survives a nonsense config: warns, still registers, refuses at call time', async () => {
  const { proxy, registered } = cordisLikeCtx();
  assert.doesNotThrow(() => apply(proxy, { skillRoot: 42, nonsense: true }));
  assert.deepEqual(registered, EXPECTED_TOOLS);

  const broken = buildTools({ config: { skillRoot: '/tmp/x', allowReplace: false }, problems: ['skillRoot 无效'] });
  await assert.rejects(broken[0].execute({ name: 'a', description: 'b', body: 'c' }), /配置有误/);
});

/* -------------------------------------------------------------------------- */
/* The nudge: a standing instruction, registered only when the service exists. */
/* -------------------------------------------------------------------------- */

function nudgeHarness({ nudge = true, withPrompt = true } = {}) {
  const sections = [];
  const services = {};
  if (withPrompt) {
    services.systemPrompt = { section: (definition) => { sections.push(definition); return () => {}; } };
  }
  const { proxy, registered } = cordisLikeCtx({ services });
  apply(proxy, { skillRoot: '/tmp/lantai-nudge', nudge });
  return { sections, registered };
}

test('the nudge is registered with a finite order and no interpolation', () => {
  const { sections } = nudgeHarness();
  assert.equal(sections.length, 1);
  const [section] = sections;
  assert.equal(section.name, 'lantai');
  assert.equal(Number.isFinite(section.order), true);
  assert.equal(section.interpolate, false);
  assert.match(section.text, /兰台/);
  assert.match(section.text, /skill_distill/);
  assert.match(section.text, /skill_attest/);
});

test('the nudge can be turned off', () => {
  assert.deepEqual(nudgeHarness({ nudge: false }).sections, []);
});

test('a composition without the prompt service still loads', () => {
  const { sections, registered } = nudgeHarness({ withPrompt: false });
  assert.deepEqual(sections, []);
  assert.equal(registered.length, EXPECTED_TOOLS.length);
});
