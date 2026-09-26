import { defineConfig } from 'oxfmt';

export default defineConfig({
  singleQuote: true,
  jsxSingleQuote: false,
  quoteProps: 'consistent',
  bracketSpacing: true,
  bracketSameLine: false,
  arrowParens: 'always',
  singleAttributePerLine: true,
  semi: true,
  printWidth: 100,
  proseWrap: 'preserve',
  sortPackageJson: {
    sortScripts: true,
  },
  sortImports: {
    customGroups: [
      {
        elementNamePattern: ['node:*'],
        groupName: 'node',
      },
      {
        elementNamePattern: ['./**'],
        groupName: 'local',
      },
    ],
    groups: [
      'node',
      'external',
      { newlinesBetween: true },
      'local',
      { newlinesBetween: true },
      ['parent', 'sibling', 'index'],
    ],
    newlinesBetween: false,
  },
  ignorePatterns: [
    'node_modules',
    'dist/**',
    '**/pnpm-lock.yaml',
    '**/*.tsbuildinfo',
    '.agents/**',
  ],
});
