import { hashString, mulberry32, pick } from '../util/math';
import type { Panel } from './types';

const VERBS = [
  'load',
  'save',
  'render',
  'layout',
  'resolve',
  'update',
  'sync',
  'index',
  'scan',
  'mount',
  'focus',
  'search',
  'parse',
  'flush',
  'merge',
  'cache',
  'diff',
  'watch',
  'create',
  'select',
] as const;

const NOUNS = [
  'Camera',
  'Panel',
  'Glyph',
  'Atlas',
  'Buffer',
  'Editor',
  'Scene',
  'Graph',
  'Token',
  'Worker',
  'Layout',
  'Viewport',
  'Selection',
  'Symbol',
  'Diagnostic',
  'Workspace',
  'Document',
  'Group',
  'Minimap',
  'Bookmark',
] as const;

const ADJECTIVES = [
  'fast',
  'lazy',
  'dirty',
  'active',
  'visible',
  'pending',
  'shared',
  'local',
  'remote',
  'cached',
  'sorted',
  'stable',
  'virtual',
  'folded',
] as const;

const IMPORTS = ['../lib', '../scene', '../render', './shared', '../services', '../util'] as const;

const DECLARATIONS = [
  'display: flex;',
  'display: grid;',
  'align-items: center;',
  'justify-content: space-between;',
  'gap: 8px;',
  'padding: 10px 14px;',
  'margin: 0;',
  'border-radius: 8px;',
  'color: #dbe4f0;',
  'background: rgba(13, 17, 25, 0.82);',
  'border: 1px solid rgba(120, 145, 180, 0.16);',
  'font-size: 12px;',
  'line-height: 1.55;',
  'position: relative;',
  'overflow: hidden;',
  'transition: transform 120ms ease;',
  'box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);',
  'pointer-events: auto;',
  'user-select: none;',
] as const;

const SENTENCES = [
  'Panels are culled by a uniform spatial hash before any draw call is issued.',
  'The editor mounts at native scale once a panel crosses the edit threshold.',
  'Glyphs are rasterized once and reused at every zoom level.',
  'Layout is deterministic so the same workspace always produces the same map.',
  'Camera flights ease toward their target without blocking input.',
  'Dirty panels keep their draft in memory until the file is written back.',
  'Directory frames provide spatial anchoring while zooming through the world.',
  'Token runs replace the procedural silhouette once parsing is available.',
  'Selection and hover rings are drawn in screen space to stay crisp.',
  'The workspace provider hides whether files come from disk or memory.',
] as const;

function pascal(value: string): string {
  const cleaned = value
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  const result = parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
  return result || 'Module';
}

function camel(value: string): string {
  const name = pascal(value);
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function interfaceBlock(base: string, random: () => number): string[] {
  const name = `${base}${pick(['Options', 'State', 'Result', 'Context', 'Snapshot'], random)}`;
  const lines = [`export interface ${name} {`];
  const count = 3 + Math.floor(random() * 5);
  for (let i = 0; i < count; i += 1) {
    const field = `${pick(ADJECTIVES, random)}${pick(NOUNS, random)}`;
    const type = pick(
      ['string', 'number', 'boolean', `${pick(NOUNS, random)}[]`, 'Record<string, unknown>'],
      random,
    );
    lines.push(`  ${field}: ${type};`);
  }
  lines.push('}');
  return lines;
}

function typeBlock(base: string, random: () => number): string[] {
  const name = `${base}${pick(['Event', 'Handler', 'Mode', 'Kind', 'Phase'], random)}`;
  const options = ['idle', 'loading', 'ready', 'error', 'disposed'];
  const count = 2 + Math.floor(random() * 3);
  const lines = [`export type ${name} =`];
  for (let i = 0; i < count; i += 1) {
    lines.push(`  | '${options[i]}'${i === count - 1 ? ';' : ''}`);
  }
  return lines;
}

function functionBlock(base: string, random: () => number, jsx: boolean): string[] {
  const noun = pick(NOUNS, random);
  const verb = pick(VERBS, random);
  const name = `${verb}${noun}`;
  const argument = pick(['input', 'options', 'context', 'panel', 'state'], random);

  if (jsx && random() > 0.45) {
    const root = camel(base);
    return [
      `export function ${base}Panel({ id, title }: { id: string; title: string }) {`,
      `  const [open, setOpen] = useState(false);`,
      `  const active = useMemo(() => Boolean(id), [id]);`,
      '',
      `  return (`,
      `    <section className="${root}-panel" data-id={id} data-active={active}>`,
      `      <header className="${root}-header" onClick={() => setOpen((value) => !value)}>`,
      `        {title}`,
      `      </header>`,
      `      {open ? <div className="${root}-body" /> : null}`,
      `    </section>`,
      `  );`,
      `}`,
    ];
  }

  const returnType = pick(
    ['number', 'string', 'boolean', `${noun}[]`, 'Map<string, number>'],
    random,
  );
  return [
    `export function ${name}(${argument}: ${base}Options): ${returnType} {`,
    `  const startedAt = performance.now();`,
    `  let total = 0;`,
    '',
    `  for (const item of items) {`,
    `    total += item.weight * ${1 + Math.floor(random() * 9)};`,
    `  }`,
    '',
    `  return Math.max(0, total - startedAt);`,
    `}`,
  ];
}

function classBlock(base: string, random: () => number): string[] {
  const name = `${base}${pick(['Controller', 'Store', 'Service', 'Cache', 'Registry'], random)}`;
  return [
    `export class ${name} {`,
    `  private readonly items = new Map<string, ${base}Options>();`,
    `  private readonly listeners = new Set<() => void>();`,
    '',
    `  constructor(private readonly root: string) {}`,
    '',
    `  get size(): number {`,
    `    return this.items.size;`,
    `  }`,
    '',
    `  set(key: string, value: ${base}Options): void {`,
    `    this.items.set(key, value);`,
    `    for (const listener of this.listeners) listener();`,
    `  }`,
    '',
    `  subscribe(listener: () => void): () => void {`,
    `    this.listeners.add(listener);`,
    `    return () => this.listeners.delete(listener);`,
    `  }`,
    `}`,
  ];
}

function constBlock(base: string, random: () => number): string[] {
  const name = `${pick(ADJECTIVES, random)}${pick(NOUNS, random)}`;
  return [
    `const ${camel(name)} = {`,
    `  id: '${name.toLowerCase()}',`,
    `  owner: '${camel(base)}',`,
    `  enabled: ${random() > 0.5},`,
    `  weight: ${(random() * 10).toFixed(2)},`,
    `} as const;`,
  ];
}

function commentBlock(random: () => number): string[] {
  return [
    '/**',
    ` * ${pick(SENTENCES, random)}`,
    ` * ${pick(SENTENCES, random)}`,
    ' */',
  ];
}

function generateScript(
  panel: Panel,
  random: () => number,
  target: number,
  jsx: boolean,
): string[] {
  const base = pascal(panel.name);
  const lines: string[] = [`// ${panel.path}`, ''];

  if (jsx) {
    lines.push(`import { useMemo, useState } from 'react';`);
  }
  const importCount = 1 + Math.floor(random() * 3);
  for (let i = 0; i < importCount; i += 1) {
    const source = pick(IMPORTS, random);
    const symbol = `${pick(NOUNS, random)}${i > 0 ? i : ''}`;
    lines.push(`import { ${symbol} } from '${source}/${pick(VERBS, random)}-${symbol.toLowerCase()}';`);
  }
  lines.push('');

  while (lines.length < target - 6) {
    const roll = random();
    if (roll < 0.16) {
      lines.push(...interfaceBlock(base, random));
    } else if (roll < 0.3) {
      lines.push(...typeBlock(base, random));
    } else if (roll < 0.56) {
      lines.push(...functionBlock(base, random, jsx));
    } else if (roll < 0.7) {
      lines.push(...classBlock(base, random));
    } else if (roll < 0.84) {
      lines.push(...constBlock(base, random));
    } else {
      lines.push(...commentBlock(random));
    }
    lines.push('');
  }

  return lines;
}

function generateCss(panel: Panel, random: () => number, target: number): string[] {
  const lines: string[] = [`/* ${panel.path} */`, '', ':root {'];

  for (let i = 0; i < 6; i += 1) {
    const name = `${pick(ADJECTIVES, random)}-${pick(NOUNS, random).toLowerCase()}`;
    const value = pick(
      ['12px', '0.82', 'rgba(13, 17, 25, 0.82)', '#6ea8fe', 'cubic-bezier(0.2, 0.8, 0.2, 1)'],
      random,
    );
    lines.push(`  --${name}: ${value};`);
  }
  lines.push('}', '');

  while (lines.length < target - 3) {
    const name = `${pick(ADJECTIVES, random)}-${pick(NOUNS, random).toLowerCase()}`;
    const suffix = random() > 0.7 ? ':hover' : random() > 0.8 ? ' > *' : '';
    lines.push(`.${name}${suffix} {`);
    const count = 2 + Math.floor(random() * 5);
    for (let i = 0; i < count; i += 1) {
      lines.push(`  ${pick(DECLARATIONS, random)}`);
    }
    lines.push('}', '');
  }

  return lines;
}

function generateJson(panel: Panel, random: () => number, target: number): string[] {
  const base = camel(panel.name);
  const lines: string[] = [
    '{',
    `  "name": "${base}",`,
    '  "version": "0.1.0",',
    '  "private": true,',
    '  "items": [',
  ];

  const count = Math.max(4, Math.floor((target - 10) / 6));
  for (let i = 0; i < count; i += 1) {
    lines.push('    {');
    lines.push(`      "id": ${i + 1},`);
    lines.push(
      `      "label": "${pick(ADJECTIVES, random)} ${pick(NOUNS, random).toLowerCase()}",`,
    );
    lines.push(`      "enabled": ${random() > 0.35},`);
    lines.push(`      "weight": ${(random() * 100).toFixed(1)}`);
    lines.push(`    }${i === count - 1 ? '' : ','}`);
  }

  lines.push('  ]');
  lines.push('}');
  return lines;
}

function generateMarkdown(panel: Panel, random: () => number, target: number): string[] {
  const lines: string[] = [
    `# ${pascal(panel.name)}`,
    '',
    `> ${pick(ADJECTIVES, random)} ${pick(NOUNS, random).toLowerCase()} notes for ${panel.path}`,
    '',
  ];

  while (lines.length < target - 4) {
    const roll = random();
    if (roll < 0.22) {
      lines.push(`## ${pick(ADJECTIVES, random)} ${pick(NOUNS, random).toLowerCase()}`, '');
    } else if (roll < 0.46) {
      lines.push(
        `- ${pick(SENTENCES, random)}`,
        `- ${pick(SENTENCES, random)}`,
        `- ${pick(SENTENCES, random)}`,
        '',
      );
    } else if (roll < 0.64) {
      lines.push(
        '```ts',
        `const ${camel(pick(NOUNS, random))} = create${pick(NOUNS, random)}();`,
        '```',
        '',
      );
    } else {
      lines.push(`${pick(SENTENCES, random)} ${pick(SENTENCES, random)}`, '');
    }
  }

  return lines;
}

function generateRust(panel: Panel, random: () => number, target: number): string[] {
  const base = pascal(panel.name);
  const lines: string[] = [`// ${panel.path}`, '', 'use std::collections::HashMap;', ''];

  while (lines.length < target - 4) {
    const roll = random();
    if (roll < 0.32) {
      lines.push('#[derive(Debug, Clone, Default)]');
      lines.push(`pub struct ${base}${pick(['State', 'Config', 'Entry', 'Cache'], random)} {`);
      for (let i = 0; i < 3; i += 1) {
        const field = `${pick(ADJECTIVES, random)}_${pick(NOUNS, random).toLowerCase()}`;
        lines.push(`    pub ${field}: ${pick(['String', 'usize', 'bool', 'f64'], random)},`);
      }
      lines.push('}', '');
    } else if (roll < 0.62) {
      lines.push(`impl ${base}State {`);
      lines.push(`    pub fn ${pick(VERBS, random)}(&self) -> usize {`);
      lines.push('        let mut total = 0;');
      lines.push('        for value in self.values() {');
      lines.push('            total += value;');
      lines.push('        }');
      lines.push('        total');
      lines.push('    }');
      lines.push('}', '');
    } else {
      const name = `${pick(VERBS, random)}_${pick(NOUNS, random).toLowerCase()}`;
      lines.push(`fn ${name}(input: &str) -> String {`);
      lines.push('    let mut output = String::new();');
      lines.push('    for line in input.lines() {');
      lines.push('        output.push_str(line.trim());');
      lines.push('    }');
      lines.push('    output');
      lines.push('}', '');
    }
  }

  return lines;
}

function generateHtml(panel: Panel, random: () => number, target: number): string[] {
  const base = camel(panel.name);
  const lines: string[] = [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `    <title>${pascal(panel.name)}</title>`,
    '    <link rel="stylesheet" href="./style.css" />',
    '  </head>',
    '  <body>',
    `    <div class="${base}-app">`,
  ];

  while (lines.length < target - 6) {
    const name = `${pick(ADJECTIVES, random)}-${pick(NOUNS, random).toLowerCase()}`;
    lines.push(`      <section class="${name}">`);
    lines.push(`        <h2>${pick(NOUNS, random)}</h2>`);
    lines.push(`        <p>${pick(SENTENCES, random)}</p>`);
    lines.push('      </section>');
  }

  lines.push('    </div>');
  lines.push('    <script type="module" src="./main.ts"></script>');
  lines.push('  </body>');
  lines.push('</html>');
  return lines;
}

function generateText(panel: Panel, random: () => number, target: number): string[] {
  const lines: string[] = [`${pascal(panel.name)}`, ''];

  while (lines.length < target - 2) {
    const roll = random();
    if (roll < 0.2) {
      lines.push(`${pick(ADJECTIVES, random).toUpperCase()} ${pick(NOUNS, random).toUpperCase()}`);
      lines.push('');
    } else if (roll < 0.4) {
      lines.push(`- ${pick(SENTENCES, random)}`);
    } else {
      lines.push(`${pick(SENTENCES, random)} ${pick(SENTENCES, random)}`, '');
    }
  }

  return lines;
}

/** Deterministic, plausible file contents for the mock workspace. */
export function generateMockContent(panel: Panel): string {
  const random = mulberry32(hashString(panel.path) ^ 0x51ed270b);
  const target = Math.max(12, panel.lines);

  switch (panel.language) {
    case 'ts':
      return generateScript(panel, random, target, false).join('\n');
    case 'tsx':
      return generateScript(panel, random, target, true).join('\n');
    case 'js':
      return generateScript(panel, random, target, false).join('\n');
    case 'jsx':
      return generateScript(panel, random, target, true).join('\n');
    case 'css':
      return generateCss(panel, random, target).join('\n');
    case 'json':
      return generateJson(panel, random, target).join('\n');
    case 'md':
      return generateMarkdown(panel, random, target).join('\n');
    case 'rust':
      return generateRust(panel, random, target).join('\n');
    case 'html':
      return generateHtml(panel, random, target).join('\n');
    case 'other':
      return generateText(panel, random, target).join('\n');
  }
}
