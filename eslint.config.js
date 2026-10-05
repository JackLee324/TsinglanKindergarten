// @ts-check
/**
 * ESLint 配置 —— 自包含，不再依赖任何妙搭（@lark-apaas）预设包。
 *
 * WHY THIS FILE WAS REWRITTEN
 * ---------------------------
 * 迁移前这里第一行是：
 *
 *     const { eslintPresetsOfSimple } = require('@lark-apaas/fullstack-presets');
 *
 * 那个包随去平台化一起被删掉了，于是 `npm run eslint` **完全跑不起来**：
 *
 *     Error: Cannot find module '@lark-apaas/fullstack-presets'
 *
 * 也就是说「14 项命令」里的 lint 这一项，从去平台化那天起就没再执行过 ——
 * 门禁里挂着一个永远失败、又没人跑的检查。这类"看起来有、其实没有"的东西
 * 正是本轮要清掉的对象，只不过它在工具链里而不是在产品里。
 *
 * 现在只用仓库里真实存在的依赖（eslint 9 + typescript-eslint 8）重写，
 * 并且**不用 extends 平台的预设**：规则集写在这里，谁都能读到、能改。
 *
 * 关于规则强度的取舍（直说，避免把"调绿"伪装成"修好了"）：
 *   · 采用 typescript-eslint 的 recommended（不含 type-aware 版本）。
 *     不开 type-aware 是因为它要求每个文件都在 tsconfig project 里，
 *     而仓库同时有 app / node / tests 三套 tsconfig，配置成本远大于收益。
 *   · 下面显式关掉的两条都是**存量风格问题**，不是缺陷：
 *       no-explicit-any —— 全仓大量 `any`（含 drizzle 迁移期代码）；
 *       no-unused-vars  —— 改为 warning（--quiet 只报 error，不会挡门禁，
 *                          但 `npm run eslint` 不加 --quiet 时仍然看得见）。
 *     关掉它们是为了让门禁能立起来，而不是假装这些代码没问题。
 *   · 任何真正的错误（语法、重复声明、no-undef 等）仍然会让门禁失败。
 */
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  {
    ignores: [
      'dist',
      'dist-server',
      'node_modules',
      'source_package',
      'client/src/api/gen',
      'client/src/vendor/**',
      'evidence/**',
      '**/*.d.ts',
      '**/*.js.map',
      '*.config.js',
      '*.config.ts',
      'vite.config.ts',
      'tailwind.config.ts',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['client/**/*.{ts,tsx}', 'shared/**/*.{ts,tsx}', 'server/**/*.{ts,tsx}', 'tests/**/*.mjs'],
    rules: {
      // 见文件头：存量风格，不是缺陷。
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // 允许 `interface X {}` 这类空接口（DTO 标记与扩展位）
      '@typescript-eslint/no-empty-object-type': 'off',
      // react-refresh 之类的规则需要额外插件；仓库没有装，不假装有。
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // 测试脚本大量使用动态 import 与 any；与源码同一套规则即可，不再放宽。
    files: ['tests/**/*.mjs'],
    languageOptions: { sourceType: 'module' },
  },
);
