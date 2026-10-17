import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import hooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '.dist/**',
      '.state/**',
      '.qvac/**',
      '.venv/**',
      '**/state/**',
      '**/target/**',
      '**/vendor/**',
      'tools/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended, prettier],
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs,jsx}'],
    // TypeScript checks unresolved names only in TS; plain JS still needs this rule.
    rules: { 'no-undef': 'error' },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}', 'apps/local-client/ui/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': hooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'error' },
  },
);
