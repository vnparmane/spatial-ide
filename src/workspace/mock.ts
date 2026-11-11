import { groupColor } from '../util/color';
import { mulberry32, pick } from '../util/math';
import { layoutWorkspace } from '../scene/layout';
import type { Bounds, Group, Language, Panel, Workspace } from './types';

const DIRECTORIES = [
  'src/app',
  'src/components',
  'src/features/auth',
  'src/features/billing',
  'src/features/editor',
  'src/features/search',
  'src/features/settings',
  'src/features/workspace',
  'src/hooks',
  'src/lib',
  'src/lib/graph',
  'src/lib/layout',
  'src/lib/render',
  'src/lib/text',
  'src/lib/workers',
  'src/scene',
  'src/scene/camera',
  'src/scene/input',
  'src/scene/selection',
  'src/render',
  'src/render/atlas',
  'src/render/overlays',
  'src/render/passes',
  'src/editor',
  'src/editor/bridge',
  'src/editor/state',
  'src/ui',
  'src/ui/chrome',
  'src/ui/commands',
  'src/ui/dialogs',
  'src/ui/theme',
  'src/services',
  'src/services/git',
  'src/services/lsp',
  'src/services/search',
  'src/services/watch',
  'src/styles',
  'src/types',
  'tests',
  'bench',
] as const;

const VERBS = [
  'create',
  'parse',
  'render',
  'layout',
  'resolve',
  'update',
  'sync',
  'watch',
  'index',
  'scan',
  'mount',
  'focus',
  'select',
  'search',
  'load',
  'save',
  'diff',
  'merge',
  'cache',
  'flush',
] as const;

const NOUNS = [
  'camera',
  'panel',
  'glyph',
  'atlas',
  'buffer',
  'editor',
  'scene',
  'graph',
  'token',
  'worker',
  'layout',
  'viewport',
  'selection',
  'symbol',
  'diagnostic',
  'workspace',
  'document',
  'group',
  'minimap',
  'bookmark',
] as const;

const EXTENSIONS: ReadonlyArray<readonly [Language, number]> = [
  ['ts', 0.44],
  ['tsx', 0.22],
  ['js', 0.08],
  ['jsx', 0.04],
  ['css', 0.07],
  ['json', 0.05],
  ['md', 0.05],
  ['rust', 0.05],
];

const FILES_PER_GROUP = 50;
const SEED = 0x5eed1a7;

function pickLanguage(random: () => number): Language {
  let roll = random();
  for (const [language, weight] of EXTENSIONS) {
    roll -= weight;
    if (roll <= 0) return language;
  }
  return 'ts';
}

export function createMockWorkspace(): Workspace {
  const random = mulberry32(SEED);
  const panels: Panel[] = [];
  const groups: Group[] = [];

  DIRECTORIES.forEach((directory, groupIndex) => {
    const groupPanels: number[] = [];
    const usedNames = new Set<string>();

    for (let fileIndex = 0; fileIndex < FILES_PER_GROUP; fileIndex += 1) {
      const language = pickLanguage(random);
      const extension = language === 'other' ? 'txt' : language;
      const verb = pick(VERBS, random);
      const noun = pick(NOUNS, random);
      let base = `${verb}-${noun}`;
      if (usedNames.has(base)) base = `${base}-${fileIndex}`;
      usedNames.add(base);

      const name = `${base}.${extension}`;
      const path = `${directory}/${name}`;
      const lines = Math.round(20 + Math.pow(random(), 1.7) * 1400);
      const width = Math.min(400, Math.max(170, 150 + Math.sqrt(lines) * 8.5));
      const height = Math.min(250, Math.max(120, width * (0.58 + random() * 0.12)));

      const roll = random();
      const git = roll < 0.07 ? 'modified' : roll < 0.1 ? 'added' : roll < 0.11 ? 'deleted' : 'clean';

      const id = panels.length;
      panels.push({
        id,
        docId: path,
        path,
        name,
        language,
        x: 0,
        y: 0,
        w: Math.round(width),
        h: Math.round(height),
        groupId: groupIndex,
        lines,
        git,
        dirty: random() < 0.025,
      });
      groupPanels.push(id);
    }

    const groupName = directory.split('/').pop() ?? directory;
    groups.push({
      id: groupIndex,
      name: groupName,
      path: directory,
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      panelIds: groupPanels,
      color: groupColor(directory),
    });
  });

  const bounds: Bounds = layoutWorkspace(panels, groups);

  return {
    rootPath: 'spatial-ide',
    panels,
    groups,
    bounds,
  };
}

