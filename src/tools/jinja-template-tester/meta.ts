import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'jinja-template-tester',
  matrixSlug: 'jinja',
  name: 'Jinja Template Tester',
  description: 'Test Home Assistant Jinja templates locally against sample entity state.',
  category: 'Homelab',
  keywords: [
    'home assistant template tester',
    'jinja2 tester online',
    'ha template editor',
    'test jinja template',
    'home assistant jinja sandbox',
  ],
  input: 'text/plain',
  output: 'text/plain',
  options: [
    {
      kind: 'text',
      id: 'state',
      label: 'Sample entity state (YAML or JSON)',
      default: 'sensor.kitchen_temperature:\n  state: "21.5"',
      placeholder: 'sensor.kitchen_temperature:\n  state: "21.5"',
    },
  ],
  copy: {
    what: 'Renders Home Assistant Jinja templates in your browser using the real Python jinja2 engine, the same engine Home Assistant uses. You define a sample set of entities with their state and attributes, then the tool stubs the Home Assistant template functions (states, is_state, state_attr, now, and more) over that sample data so your template runs exactly as it parses. Because it is real jinja2, constructs that other online testers get wrong, like namespace() and the full filter set, work here.',
    how: 'Write your template in the top editor and describe a few entities in the sample state editor below it, as YAML or JSON. Load the template engine once (about 13 MB, cached for later visits), then the output updates as you type. Template errors are shown with the line number and the reason, so an unclosed tag or an undefined variable is easy to find.',
    why: 'Home Assistant\'s own template editor needs a running instance you can reach, and the popular online Jinja testers use a JavaScript engine that does not match Home Assistant: it has no namespace() and no HA functions, so templates that work there can still fail in your config. This one runs the real Python jinja2 engine with the Home Assistant functions stubbed over sample state you control, so what renders here is what the template language does. Everything runs in this tab: your files and inputs never leave your device.',
    faq: [
      {
        q: 'Does this match Home Assistant exactly?',
        a: 'The template engine is identical: real Python jinja2, so syntax, filters, tests, and namespace() behave the same. The Home Assistant functions are stubbed over the sample state you provide rather than read from a live instance, so states, is_state, state_attr, has_value, and states.<domain> are faithful to your sample. Functions that need a running instance or the network are not stubbed: service calls, expand() over live groups, distance() to real coordinates, and device or area lookups. now() and utcnow() use the real current time.',
      },
      {
        q: 'Why the large download?',
        a: 'Rendering real jinja2 means running Python, so the tool downloads Pyodide, a build of CPython compiled to WebAssembly, plus the jinja2 and MarkupSafe packages. That is about 13 MB total, fetched only when you choose to load the engine and cached so later visits are instant. It is served from this site, never a third party.',
      },
      {
        q: 'Is my template uploaded anywhere?',
        a: 'No. The engine and your template both run inside this browser tab, and the page works offline once the engine is cached: your files and inputs never leave your device.',
      },
    ],
  },
};
