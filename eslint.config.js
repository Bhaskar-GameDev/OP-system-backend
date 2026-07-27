// @ts-check
const js = require('@eslint/js');
const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

/**
 * ESLint 9 flat config. `npm run lint` has been failing with "couldn't find
 * eslint.config.js" since the ESLint 9 bump — the plugin and parser were both
 * already installed, only the config was missing.
 *
 * Scope is src + test, matching the lint script. Type-aware rules are ON
 * (parserOptions.project), because the checks worth having here — floating
 * promises above all, in a codebase where a dropped await means a token is
 * never issued — cannot be done without type information.
 */
module.exports = [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'prisma/migrations/**', 'eslint.config.js'],
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: __dirname,
        sourceType: 'module',
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      // Core recommended first — the `eslint-disable` comments already in the
      // tree (no-constant-condition, no-console) were written against it.
      ...js.configs.recommended.rules,
      ...tsPlugin.configs['eslint-recommended'].overrides[0].rules,
      ...tsPlugin.configs.recommended.rules,

      // Nest resolves constructor params by decorator metadata, and DTO classes
      // carry validation decorators, so "unused" is a false positive there.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

      // A dropped await on an engine call silently loses the write. This is the
      // rule the config exists for.
      '@typescript-eslint/no-floating-promises': 'error',

      // Prisma's JSON columns and the event-store payloads are genuinely `any`
      // at the boundary; they are narrowed at the point of use instead.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];
