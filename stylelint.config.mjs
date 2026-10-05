/**
 * Stylelint 配置 —— 自包含，不依赖任何未安装的预设包。
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `npm run stylelint` 在此之前是**完全跑不起来**的：
 *
 *     ConfigurationError: No configuration provided for client/src/...css
 *
 * 仓库里没有 .stylelintrc*，也没有 stylelint.config.*，而 package.json 里却挂着
 * 这条命令。也就是说「14 项命令」里的 stylelint 从来没有真正执行过。
 * 这和 eslint 是同一类问题（那条依赖已删除的 @lark-apaas 预设包），只是表现不同：
 * 一个是找不到模块，一个是根本没有配置。
 *
 * 关于规则集的取舍（直说，不把"调绿"说成"修好了"）：
 *   · 仓库只安装了裸 stylelint，没有 stylelint-config-standard。所以这里**显式列规则**，
 *     不写 `extends`，避免又变成"依赖一个不存在的东西"。
 *   · 只启用**正确性**规则（无效的值、重复声明、未知单位/属性等），
 *     不启用任何格式化/风格规则 —— 风格规则会在 Tailwind v4 的产出上大量误报，
 *     且与本轮"不重做 UI"的约束相冲突。
 *   · 不启用 `at-rule-no-unknown`：Tailwind v4 的 @import/@theme/@apply/@utility/@custom-variant
 *     对这条规则来说是"未知的 at-rule"，启用它就只能靠不断加白名单来维持，
 *     而白名单一旦漏掉新语法，门禁会以"配置问题"的形式误报。
 */
export default {
  // vendor/ 下是第三方样式（toolkit-*），不属于本项目代码
  ignoreFiles: ['client/src/vendor/**', 'dist/**', 'node_modules/**'],
  rules: {
    // 拼写/取值类：这些是真正的错误，不是风格
    'color-no-invalid-hex': true,
    'unit-no-unknown': true,
    'property-no-unknown': [true, { ignoreProperties: ['composes', 'compose-with'] }],
    'function-no-unknown': [true, { ignoreFunctions: ['theme', 'screen'] }],
    // 结构类：重复声明/重复选择器通常是复制粘贴留下的真问题
    'declaration-block-no-duplicate-properties': [
      true,
      { ignore: ['consecutive-duplicates-with-different-values'] },
    ],
    'no-duplicate-selectors': true,
    'block-no-empty': true,
    'no-empty-source': true,
    // 明显写错的选择器
    'selector-pseudo-class-no-unknown': [true, { ignorePseudoClasses: ['global', 'local'] }],
    'selector-pseudo-element-no-unknown': true,
    'media-feature-name-no-unknown': true,
    'at-rule-empty-line-before': null,
  },
};
