/**
 * The contract layer.
 *
 * DSH's tool registry does NOT compile `parameters` — it hands whatever object you
 * declare straight to the model. `defineTool()` is the compiler. If a plugin skips
 * it (as one did, and took the whole harness down with a malformed schema), the fix
 * is to compile the spec here and prove the result is legal before registering.
 *
 * This file is deliberately a *local mirror* of the rules the harness enforces:
 *   - supported JSON Schema subset: type / oneOf / properties / required /
 *     additionalProperties / items / enum / const + description / title annotations
 *   - object-rooted parameter object
 * Keeping the mirror in-repo means a DSH upgrade that widens or narrows the subset
 * fails our tests instead of failing someone's app.
 */
export const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

const CONSTRAINT_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
]);

const ANNOTATION_KEYWORDS = new Set(['description', 'title']);

export class SchemaError extends Error {
  constructor(violations) {
    super(`unsupported tool schema:\n- ${violations.join('\n- ')}`);
    this.name = 'SchemaError';
    this.violations = violations;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalarMatches(type, value) {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

/** Walk a raw schema and collect every violation of the supported subset. */
export function collectSchemaViolations(schema, path = 'schema', seen = new Set()) {
  const violations = [];
  if (!isPlainObject(schema)) {
    violations.push(`${path} must be a schema object`);
    return violations;
  }
  if (seen.has(schema)) {
    violations.push(`${path} is circular`);
    return violations;
  }
  seen.add(schema);

  for (const key of Object.keys(schema)) {
    if (CONSTRAINT_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key)) continue;
    violations.push(
      `${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + description/title)`,
    );
  }
  if (Object.hasOwn(schema, 'description') && typeof schema.description !== 'string') {
    violations.push(`${path}.description must be a string`);
  }
  if (Object.hasOwn(schema, 'title') && typeof schema.title !== 'string') {
    violations.push(`${path}.title must be a string`);
  }

  const hasType = Object.hasOwn(schema, 'type');
  const hasOneOf = Object.hasOwn(schema, 'oneOf');
  if (hasType && hasOneOf) return violations.concat([`${path} cannot declare both type and oneOf`]);
  if (!hasType && !hasOneOf) {
    for (const key of ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']) {
      if (Object.hasOwn(schema, key)) violations.push(`${path}.${key} requires type or oneOf`);
    }
    return violations;
  }

  if (hasOneOf) {
    const options = schema.oneOf;
    if (!Array.isArray(options) || options.length < 2) {
      violations.push(`${path}.oneOf must be an array of at least two schemas`);
    } else {
      options.forEach((option, index) => {
        violations.push(...collectSchemaViolations(option, `${path}.oneOf[${index}]`, seen));
      });
    }
    return violations;
  }

  const type = schema.type;
  if (!SCHEMA_TYPES.includes(type)) {
    violations.push(`${path}.type must be one of ${SCHEMA_TYPES.join('/')}`);
    return violations;
  }

  const allowedFor = {
    properties: ['object'],
    required: ['object'],
    additionalProperties: ['object'],
    items: ['array'],
    enum: ['string', 'number', 'integer'],
  };
  for (const [key, types] of Object.entries(allowedFor)) {
    if (Object.hasOwn(schema, key) && !types.includes(type)) {
      violations.push(`${path}.${key} is only valid on ${types.join('/')}`);
    }
  }
  if (Object.hasOwn(schema, 'const') && !['string', 'number', 'integer', 'boolean', 'null'].includes(type)) {
    violations.push(`${path}.const is not valid on ${type}`);
  }

  if (Object.hasOwn(schema, 'enum')) {
    const allowed = schema.enum;
    if (!Array.isArray(allowed) || allowed.length === 0 || !allowed.every((entry) => scalarMatches(type, entry))) {
      violations.push(`${path}.enum must be a non-empty array of ${type} values`);
    }
  }

  if (type === 'object') {
    if (Object.hasOwn(schema, 'properties')) {
      if (!isPlainObject(schema.properties)) {
        violations.push(`${path}.properties must be an object`);
      } else {
        for (const [name, child] of Object.entries(schema.properties)) {
          violations.push(...collectSchemaViolations(child, `${path}.properties.${name}`, seen));
        }
      }
    }
    if (Object.hasOwn(schema, 'required')) {
      const required = schema.required;
      const known = isPlainObject(schema.properties) ? Object.keys(schema.properties) : [];
      if (!Array.isArray(required) || required.some((entry) => typeof entry !== 'string')) {
        violations.push(`${path}.required must be an array of strings`);
      } else {
        for (const entry of required) {
          if (!known.includes(entry)) violations.push(`${path}.required names "${entry}", which is not a declared property`);
        }
      }
    }
    if (Object.hasOwn(schema, 'additionalProperties') && typeof schema.additionalProperties !== 'boolean') {
      violations.push(`${path}.additionalProperties must be a boolean`);
    }
  }

  if (type === 'array' && Object.hasOwn(schema, 'items')) {
    violations.push(...collectSchemaViolations(schema.items, `${path}.items`, seen));
  }

  return violations;
}

export function assertSupportedJsonSchema(schema, label = 'schema') {
  const violations = collectSchemaViolations(schema, label);
  if (violations.length > 0) throw new SchemaError(violations);
  return schema;
}

/**
 * Compile the terse parameter spec into a real, object-rooted JSON Schema — the
 * job `defineTool()` performs upstream, and the one that was skipped when a
 * malformed schema crashed the harness.
 *
 * @param {Record<string, {type: string, required?: boolean, description?: string, enum?: unknown[], items?: object}>} spec
 */
export function compileParameters(spec, label = 'parameters') {
  if (spec === undefined || spec === null) spec = {};
  if (!isPlainObject(spec)) throw new SchemaError([`${label} must be an object`]);

  const properties = {};
  const required = [];
  for (const [name, field] of Object.entries(spec)) {
    if (!isPlainObject(field)) throw new SchemaError([`${label}.${name} must be an object`]);
    const { required: isRequired, ...rest } = field;
    if (!Object.hasOwn(rest, 'type')) throw new SchemaError([`${label}.${name} must declare a type`]);
    properties[name] = { ...rest };
    if (isRequired === true) required.push(name);
  }

  const schema = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return assertSupportedJsonSchema(schema, label);
}

/**
 * Argument validation for tools that register without `defineTool`. Kept minimal
 * on purpose: presence of required fields and a shallow type check.
 * @returns {string[]} violations, empty when the arguments are usable
 */
export function validateArgs(parameters, args) {
  const violations = [];
  if (!isPlainObject(args)) return ['arguments must be an object'];
  const properties = parameters.properties ?? {};
  for (const name of parameters.required ?? []) {
    if (!Object.hasOwn(args, name) || args[name] === undefined || args[name] === null) {
      violations.push(`missing required argument "${name}"`);
    }
  }
  for (const [name, value] of Object.entries(args)) {
    const schema = properties[name];
    if (!schema) {
      violations.push(`unknown argument "${name}"`);
      continue;
    }
    if (value === undefined || value === null) continue;
    if (schema.type === 'array') {
      if (!Array.isArray(value)) violations.push(`argument "${name}" must be an array`);
      continue;
    }
    if (schema.type === 'object') {
      if (!isPlainObject(value)) violations.push(`argument "${name}" must be an object`);
      continue;
    }
    if (!scalarMatches(schema.type, value)) violations.push(`argument "${name}" must be a ${schema.type}`);
    if (schema.type === 'integer' && typeof value === 'number' && !Number.isInteger(value)) {
      violations.push(`argument "${name}" must be an integer`);
    }
    if (schema.enum && !schema.enum.includes(value)) {
      violations.push(`argument "${name}" must be one of ${schema.enum.join(', ')}`);
    }
  }
  return violations;
}
