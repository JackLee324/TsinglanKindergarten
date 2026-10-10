import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '.devdata/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['server/**/*.ts', 'shared/**/*.ts'],
    languageOptions: {
      parserOptions: { project: './tsconfig.node.json', tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // TypeScript 自己就能发现未定义的变量；`no-undef` 在 TS 上只会误报类型与全局。
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      'no-console': 'off',
    },
  },
  {
    // NestJS 的依赖注入依赖装饰器与"看似未使用"的参数/属性。
    files: ['server/**/*.ts'],
    rules: {
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  {
    // `deploy/**` 一起纳入：它是运维/切换脚本，同样只该用 Node 内建全局
    // （以前它不在 lint 范围里，等于"没人看管的那部分"）。
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs', 'deploy/**/*.mjs'],
    languageOptions: {
      // Node 22 的内建全局。逐项列出而不是引第三方 globals 包 ——
      // 少一个依赖，而且"这个文件能用哪些全局"在配置里一眼可见。
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        structuredClone: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
        globalThis: 'readonly',
      },
    },
    rules: { 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
)
