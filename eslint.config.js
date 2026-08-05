import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';

export default tseslint.config(
    js.configs.recommended,
    tseslint.configs.recommended,
    {
        plugins: { '@stylistic': stylistic },
        rules: {
            '@stylistic/brace-style': ['error', 'allman'],
            '@stylistic/indent': ['error', 4],
            '@stylistic/semi': ['error', 'always'],
            '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
        },
    },
);
