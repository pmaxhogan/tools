import { describe, expect, it } from 'vitest';
import {
  buildHaGlobals,
  buildRenderProgram,
  extractResult,
  formatError,
  parseStatesInput,
  run,
} from './index';
import { ToolError } from '../types';

describe('parseStatesInput', () => {
  it('parses JSON with state and attributes', () => {
    const states = parseStatesInput(
      '{"sensor.kitchen_temp": {"state": "21.5", "attributes": {"unit_of_measurement": "\\u00b0C"}}}',
    );
    expect(states['sensor.kitchen_temp']).toEqual({
      state: '21.5',
      attributes: { unit_of_measurement: '°C' },
    });
  });

  it('parses YAML equivalently to JSON', () => {
    const yaml = [
      'sensor.kitchen_temp:',
      '  state: "21.5"',
      '  attributes:',
      '    unit_of_measurement: "°C"',
      'light.living_room:',
      '  state: "on"',
    ].join('\n');
    const states = parseStatesInput(yaml);
    expect(states['sensor.kitchen_temp']!.state).toBe('21.5');
    expect(states['sensor.kitchen_temp']!.attributes.unit_of_measurement).toBe('°C');
    expect(states['light.living_room']).toEqual({ state: 'on', attributes: {} });
  });

  it('accepts the scalar shorthand where the value is the state', () => {
    const states = parseStatesInput('light.kitchen: "on"');
    expect(states['light.kitchen']).toEqual({ state: 'on', attributes: {} });
  });

  it('folds inline keys beside state into attributes', () => {
    const states = parseStatesInput(
      '{"sensor.x": {"state": "5", "friendly_name": "Sensor X", "unit": "kWh"}}',
    );
    expect(states['sensor.x']).toEqual({
      state: '5',
      attributes: { friendly_name: 'Sensor X', unit: 'kWh' },
    });
  });

  it('coerces a numeric state to a string', () => {
    const states = parseStatesInput('{"sensor.count": {"state": 42}}');
    expect(states['sensor.count']!.state).toBe('42');
  });

  it('treats empty input as an empty map, not an error', () => {
    expect(parseStatesInput('')).toEqual({});
    expect(parseStatesInput('   \n  ')).toEqual({});
  });

  it('throws a ToolError on a top-level list', () => {
    expect(() => parseStatesInput('[1, 2, 3]')).toThrow(ToolError);
  });

  it('throws a ToolError on a bare scalar', () => {
    expect(() => parseStatesInput('just a string')).toThrow(ToolError);
  });

  it('throws a ToolError on unparseable input', () => {
    // Unbalanced flow braces are invalid YAML and invalid JSON.
    let err: unknown;
    try {
      parseStatesInput('{ this: is: not: valid');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe('invalid-state');
  });
});

describe('buildHaGlobals', () => {
  const states = parseStatesInput('sensor.kitchen_temp:\n  state: "21.5"');

  it('embeds the entity ids through json.loads', () => {
    const code = buildHaGlobals(states);
    expect(code).toContain('_STATES = json.loads(');
    expect(code).toContain('sensor.kitchen_temp');
    expect(code).toContain('21.5');
  });

  it('defines the core Home Assistant state functions', () => {
    const code = buildHaGlobals(states);
    expect(code).toContain('def is_state(');
    expect(code).toContain('def state_attr(');
    expect(code).toContain('def has_value(');
    expect(code).toContain('class _StatesProxy');
    expect(code).toContain('"now": now');
    expect(code).toContain('"states": states');
  });

  it('produces the three environment dicts', () => {
    const code = buildHaGlobals(states);
    expect(code).toContain('HA_GLOBALS, HA_FILTERS, HA_TESTS = _make_ha_env(_STATES)');
  });
});

describe('buildRenderProgram', () => {
  it('wraps the prelude with a jinja2 render harness and the template', () => {
    const states = parseStatesInput('light.kitchen: "on"');
    const program = buildRenderProgram(states, '{{ is_state("light.kitchen", "on") }}');
    expect(program).toContain('import jinja2');
    expect(program).toContain('_env.globals.update(HA_GLOBALS)');
    expect(program).toContain('_TEMPLATE = json.loads(');
    expect(program.trimEnd().endsWith('_env.from_string(_TEMPLATE).render()')).toBe(true);
  });

  it('keeps a template that contains quotes and backslashes inside a string literal', () => {
    const program = buildRenderProgram({}, '{{ "a\\"b" }}\nline two');
    // The template must survive as JSON, never breaking out of the literal.
    expect(program).toContain('json.loads(');
    // No raw unescaped template delimiter leaks onto its own program line.
    expect(program).not.toContain('\n{{ "a');
  });
});

describe('extractResult', () => {
  it('returns strings unchanged', () => {
    expect(extractResult('21.5 degrees')).toBe('21.5 degrees');
  });

  it('maps null and undefined to an empty string', () => {
    expect(extractResult(null)).toBe('');
    expect(extractResult(undefined)).toBe('');
  });

  it('stringifies other values', () => {
    expect(extractResult(42)).toBe('42');
    expect(extractResult(true)).toBe('true');
  });
});

describe('formatError', () => {
  it('reads a jinja2 syntax error and its line from an <unknown> frame', () => {
    const traceback = [
      '  File "/lib/python3.14/site-packages/jinja2/environment.py", line 942, in handle_exception',
      '    raise rewrite_traceback_stack(source=source)',
      '  File "<unknown>", line 1, in template',
      "jinja2.exceptions.TemplateSyntaxError: Encountered unknown tag 'frobnicate'.",
    ].join('\n');
    const err = formatError(traceback);
    expect(err.errorType).toBe('TemplateSyntaxError');
    expect(err.message).toBe("Encountered unknown tag 'frobnicate'.");
    expect(err.line).toBe(1);
  });

  it('reads an undefined-variable error from a <template> frame', () => {
    const traceback = [
      '  File "<template>", line 3, in top-level template code',
      '  File "/lib/python3.14/site-packages/jinja2/environment.py", line 490, in getattr',
      '    return getattr(obj, attribute)',
      "jinja2.exceptions.UndefinedError: 'foo' is undefined",
    ].join('\n');
    const err = formatError(traceback);
    expect(err.errorType).toBe('UndefinedError');
    expect(err.message).toBe("'foo' is undefined");
    expect(err.line).toBe(3);
  });

  it('reads a plain Python runtime error with its template line', () => {
    const traceback = [
      '  File "<template>", line 2, in top-level template code',
      'ZeroDivisionError: division by zero',
    ].join('\n');
    const err = formatError(traceback);
    expect(err.errorType).toBe('ZeroDivisionError');
    expect(err.message).toBe('division by zero');
    expect(err.line).toBe(2);
  });

  it('falls back to the last line when nothing matches the error pattern', () => {
    const err = formatError('something went sideways');
    expect(err.message).toBe('something went sideways');
    expect(err.line).toBeNull();
  });
});

describe('run', () => {
  it('previews the parsed state and stubbed functions without rendering', () => {
    const out = run('{{ now() }}', { state: 'sensor.temp:\n  state: "20"' });
    expect(out.entities).toContain('1 parsed');
    expect(out.entities).toContain('sensor.temp = 20');
    expect(out.template).toBe('{{ now() }}');
    expect(out.functions).toContain('states()');
    expect(out.engine).toContain('Pyodide');
  });

  it('handles an empty template and no state', () => {
    const out = run('', {});
    expect(out.template).toBe('(empty template)');
    expect(out.entities).toContain('0 parsed');
    expect(out.entities).toContain('no entities defined');
  });

  it('propagates a ToolError from an invalid sample state', () => {
    expect(() => run('{{ 1 }}', { state: '[not, a, map]' })).toThrow(ToolError);
  });
});
