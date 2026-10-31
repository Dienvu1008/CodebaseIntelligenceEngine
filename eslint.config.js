// ESLint 9 flat config. It gives fast editor feedback that duplicates the critical import bans enforced
// by dependency-cruiser (ARCHITECTURE_FITNESS §1), plus FF-CPX-001 and FF-CPX-005.
import { builtinModules } from 'node:module';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const NODE_BUILTINS = [...builtinModules.filter((m) => !m.startsWith('_')), 'node:*'];

const CODEFORGE_BAN = {
  group: ['@codeforge/*', '**/CodeForge*/**', '**/codeforge*/**'],
  message: 'CIE must never depend on CodeForge (FF-DEP-004, CODEFORGE_INTEGRATION CF-1).',
};
const VSCODE_BAN = {
  name: 'vscode',
  message: 'vscode may be imported only in packages/vscode-extension/src/host (FF-DEP-003).',
};
const UI_BUILD_BAN = {
  group: ['react', 'react-dom', 'vite', 'esbuild', 'markdown-it', 'dompurify'],
  message: 'UI and build dependencies belong only in packages/vscode-extension (FF-DEP-005).',
};

const NODE_GLOBALS = {
  process: 'readonly',
  console: 'readonly',
  URL: 'readonly',
  AbortController: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
};

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', 'coverage/**', 'tests/fitness/fixtures/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: NODE_GLOBALS },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // Repo-wide bans. More specific blocks below repeat them, because flat-config rule values override.
      'no-restricted-imports': ['error', { paths: [VSCODE_BAN], patterns: [CODEFORGE_BAN, UI_BUILD_BAN] }],
      // FF-CPX-001 (god-object guard): warn in Phases 00–02, error from Phase 03 (ratchet).
      'max-lines': ['warn', { max: 400, skipBlankLines: true, skipComments: true }],
      complexity: ['warn', 15],
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...NODE_GLOBALS, module: 'writable', require: 'readonly' } },
  },
  {
    // The pure core and the protocol: no Node built-ins and no infrastructure (FF-DEP-002, FF-DEP-006).
    files: ['packages/core/src/**/*.ts', 'packages/protocol/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [VSCODE_BAN, ...NODE_BUILTINS.filter((m) => m !== 'node:*').map((name) => ({ name, message: 'core/protocol must not import Node built-ins (FF-DEP-002b).' }))],
          patterns: [
            CODEFORGE_BAN,
            UI_BUILD_BAN,
            { group: ['node:*'], message: 'core/protocol must not import Node built-ins (FF-DEP-002b).' },
            {
              group: ['better-sqlite3', 'sql.js', 'web-tree-sitter', 'tree-sitter*', 'ollama', 'openai', '@modelcontextprotocol/*'],
              message: 'Infrastructure belongs in @cie/adapters behind a port (FF-DEP-002).',
            },
          ],
        },
      ],
      // FF-CPX-005
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
  {
    // Tests may use the vitest-style patterns `as never` / `as unknown as` when talking to untyped tool APIs.
    files: ['tests/**/*.ts', 'packages/*/test/**/*.ts'],
    rules: {
      'max-lines': 'off',
    },
  },
);
