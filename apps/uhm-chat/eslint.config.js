import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
	globalIgnores(['dist', 'dev-dist']),
	{
		files: ['**/*.{ts,tsx}'],
		extends: [
			js.configs.recommended,
			tseslint.configs.recommended,
			reactHooks.configs.flat.recommended,
			reactRefresh.configs.vite,
		],
		languageOptions: {
			ecmaVersion: 2020,
			globals: globals.browser,
		},
		rules: {
			// This app wraps a dynamic SDK contract in several customization layers.
			// Keep type safety at the `tsc -b` gate without forcing fake types for SDK callbacks.
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-empty-object-type': 'off',
			// React 19 compiler-advisory rules are not enabled for this app yet.
			'react-hooks/preserve-manual-memoization': 'off',
			'react-hooks/refs': 'off',
			'react-hooks/set-state-in-effect': 'off',
			// Shared UI primitives intentionally export variants next to components.
			'react-refresh/only-export-components': 'off',
			// Empty catch blocks are used only for best-effort browser cleanup.
			'no-empty': ['error', { allowEmptyCatch: true }],
			// Unicode validation intentionally matches control and combining ranges.
			'no-control-regex': 'off',
			'no-misleading-character-class': 'off',
		},
	},
]);
