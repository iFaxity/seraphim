import { defineConfig } from 'oxlint';

export default defineConfig({
  plugins: ['eslint', 'promise', 'unicorn', 'typescript', 'oxc', 'import'],
  options: {
    typeAware: true,
    typeCheck: true,
  },
  rules: {
    // JavaScript — correctness
    'no-empty-pattern': ['error', { allowObjectPatternsAsParameters: true }],
    // JavaScript — style
    'no-nested-ternary': 'warn',
    'func-style': ['warn', 'declaration'],
    // Import — correctness
    'import/no-duplicates': 'error',
    'import/consistent-type-specifier-style': ['warn', 'prefer-inline'],
    // TypeScript — correctness
    'typescript/no-require-imports': 'error',
    'typescript/no-explicit-any': 'error',
    'typescript/no-confusing-non-null-assertion': 'error',
    'typescript/no-non-null-assertion': 'warn',
    'typescript/prefer-nullish-coalescing': 'warn',
    'typescript/prefer-optional-chain': 'warn',
    'typescript/no-unnecessary-type-assertion': 'warn',
    'typescript/ban-ts-comment': 'warn',
    'typescript/consistent-type-definitions': ['warn', 'type'],
    // TypeScript — style
    'typescript/only-throw-error': 'warn',
    'typescript/consistent-type-assertions': ['warn', { assertionStyle: 'as' }],
    // Unicorn — style
    'unicorn/filename-case': ['error', { case: 'kebabCase' }],
    // Promise — style
    'promise/avoid-new': 'error',
  },
  ignorePatterns: ['node_modules', 'dist/**', '**/*.md', 'src/engine/templates/**'],
});
