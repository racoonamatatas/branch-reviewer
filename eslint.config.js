import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';

export default tseslint.config(
    // Build output; .vue files are not linted here either — script blocks
    // get eslint-plugin-vue treatment when the dashboard earns its own config.
    { ignores: ['dashboard/dist'] },
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
