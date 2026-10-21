// @ts-check
import { readFileSync } from 'node:fs'

import { createConfigForNuxt } from '@nuxt/eslint-config/flat'
import pluginTailwind from 'eslint-plugin-better-tailwindcss'
import pluginImport from 'eslint-plugin-import-x'
import pluginN from 'eslint-plugin-n'
import pluginPromise from 'eslint-plugin-promise'

/*
 * The web build's lint, rule for rule — this file is its `eslint.config.mjs`
 * with one part replaced: where that one imported the config Nuxt generates
 * into `.nuxt/`, this builds the same thing from `@nuxt/eslint-config`, which
 * is the package Nuxt's module generates it from and runs standalone. What the
 * module added besides is added here the same way: the app's folders, so the
 * Vue rules know a page from a component, and every auto-imported name as a
 * global (Nuxt read its import registry; here it is unplugin-auto-import's
 * record of the same, `app/auto-imports.d.ts`).
 */
const autoImports = [...readFileSync(new URL('./app/auto-imports.d.ts', import.meta.url), 'utf8')
  .matchAll(/^ {2}const (w+):/gm)].map(([, name]) => name)

const withNuxt = (...customs) => createConfigForNuxt({
  features: { standalone: true, stylistic: true },
  dirs: {
    pages: ['app/pages'],
    composables: ['app/composables', 'app/utils', 'app/utils/ocr'],
    components: ['app/components'],
    componentsPrefixed: [],
    layouts: ['app/layouts'],
    plugins: [],
    middleware: [],
    modules: [],
    servers: [],
    root: [],
    src: ['app'],
  },
}).append({
  name: 'kemolate/auto-imports',
  languageOptions: { globals: Object.fromEntries(autoImports.map((name) => [name, 'readonly'])) },
}, ...customs)

export default withNuxt(
  {
    /*
     * Worktrees this tool keeps under `.claude/` are not this project.
     *
     * They are whole checkouts of the repo, each with its own
     * `eslint.config.mjs` that imports a `.nuxt` they have never built — so
     * linting the root walks into one and dies resolving a config that cannot
     * exist. Git already ignores them through `.git/info/exclude`, which ESLint
     * does not read: it honours `.gitignore` and nothing else, so the rule has
     * to be said again here.
     */
    ignores: ['.claude/**', 'app/auto-imports.d.ts', 'app/components.d.ts'],
  },
  {
    plugins: {
      'better-tailwindcss': pluginTailwind,
      import: pluginImport,
      n: pluginN,
      promise: /** @type {any} */ (pluginPromise),
    },
    settings: {
      'import/resolver': {
        typescript: true,
        node: true,
      },
      'better-tailwindcss': {
        entryPoint: './app/assets/css/main.css',
        // Setting `attributes` REPLACES the default attribute selectors, so
        // class/className must be re-listed. The tuple form lints every string
        // value inside an object-valued prop — i.e. Nuxt UI's `:ui` slots.
        attributes: [
          'class',
          'className',
          [':ui', [{ match: 'objectValues' }]],
        ],
      },
    },
    rules: {
      'import/order': ['error', {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'object', 'type'],
        'newlines-between': 'always',
        alphabetize: {
          order: 'asc',
          caseInsensitive: true,
        },
      }],
      'sort-imports': ['error', {
        ignoreCase: true,
        ignoreDeclarationSort: true,
        ignoreMemberSort: false,
        memberSyntaxSortOrder: ['none', 'all', 'multiple', 'single'],
      }],

      // Stylistic rules
      '@stylistic/array-bracket-spacing': ['error', 'never'],
      '@stylistic/arrow-parens': ['error', 'always'],
      '@stylistic/arrow-spacing': ['error', { before: true, after: true }],
      '@stylistic/block-spacing': ['error', 'always'],
      '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: true }],
      '@stylistic/comma-dangle': ['error', 'always-multiline'],
      '@stylistic/comma-spacing': ['error', { before: false, after: true }],
      '@stylistic/comma-style': ['error', 'last'],
      '@stylistic/computed-property-spacing': ['error', 'never', { enforceForClassMembers: true }],
      '@stylistic/dot-location': ['error', 'property'],
      '@stylistic/eol-last': 'error',
      '@stylistic/function-call-spacing': ['error', 'never'],
      '@stylistic/generator-star-spacing': ['error', { before: true, after: true }],
      '@stylistic/indent': ['error', 2, {
        SwitchCase: 1,
        VariableDeclarator: 1,
        outerIIFEBody: 1,
        MemberExpression: 1,
        FunctionDeclaration: { parameters: 1, body: 1 },
        FunctionExpression: { parameters: 1, body: 1 },
        CallExpression: { arguments: 1 },
        ArrayExpression: 1,
        ObjectExpression: 1,
        ImportDeclaration: 1,
        flatTernaryExpressions: false,
        ignoreComments: false,
        ignoredNodes: [
          'TemplateLiteral *', 'JSXElement', 'JSXElement > *', 'JSXAttribute',
          'JSXIdentifier', 'JSXNamespacedName', 'JSXMemberExpression', 'JSXSpreadAttribute',
          'JSXExpressionContainer', 'JSXOpeningElement', 'JSXClosingElement', 'JSXFragment',
          'JSXOpeningFragment', 'JSXClosingFragment', 'JSXText', 'JSXEmptyExpression', 'JSXSpreadChild',
        ],
        offsetTernaryExpressions: true,
      }],
      '@stylistic/key-spacing': ['error', { beforeColon: false, afterColon: true }],
      '@stylistic/keyword-spacing': ['error', { before: true, after: true }],
      '@stylistic/lines-between-class-members': ['error', 'always', { exceptAfterSingleLine: true }],
      // Require a blank line between function declarations
      '@stylistic/padding-line-between-statements': ['error',
        { blankLine: 'always', prev: 'function', next: 'function' },
        { blankLine: 'always', prev: '*', next: 'function' },
        { blankLine: 'always', prev: 'function', next: '*' },
      ],
      '@stylistic/multiline-ternary': ['error', 'always-multiline'],
      '@stylistic/new-parens': 'error',
      '@stylistic/no-extra-parens': ['error', 'functions'],
      '@stylistic/no-floating-decimal': 'error',
      '@stylistic/no-mixed-operators': ['error', {
        groups: [
          ['==', '!=', '===', '!==', '>', '>=', '<', '<='],
          ['&&', '||'],
          ['in', 'instanceof'],
        ],
        allowSamePrecedence: true,
      }],
      '@stylistic/no-mixed-spaces-and-tabs': 'error',
      '@stylistic/no-multi-spaces': ['error', { ignoreEOLComments: true }],
      '@stylistic/no-multiple-empty-lines': ['error', { max: 1, maxBOF: 0, maxEOF: 0 }],
      '@stylistic/no-tabs': 'error',
      '@stylistic/no-trailing-spaces': 'error',
      '@stylistic/no-whitespace-before-property': 'error',
      '@stylistic/object-curly-newline': ['error', { multiline: true, consistent: true }],
      '@stylistic/object-curly-spacing': ['error', 'always'],
      '@stylistic/object-property-newline': ['error', { allowAllPropertiesOnSameLine: true }],
      '@stylistic/operator-linebreak': ['error', 'after', { overrides: { '?': 'before', ':': 'before', '|>': 'before', '|': 'before', '&&': 'before', '||': 'before', '??': 'before' } }],
      '@stylistic/padded-blocks': ['error', { blocks: 'never', switches: 'never', classes: 'never' }],
      '@stylistic/quote-props': ['error', 'as-needed'],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: 'avoidEscape' }],
      '@stylistic/rest-spread-spacing': ['error', 'never'],
      '@stylistic/semi': ['error', 'never'],
      '@stylistic/semi-spacing': ['error', { before: false, after: true }],
      '@stylistic/space-before-blocks': ['error', 'always'],
      '@stylistic/space-before-function-paren': ['error', 'always'],
      '@stylistic/space-in-parens': ['error', 'never'],
      '@stylistic/space-infix-ops': 'error',
      '@stylistic/space-unary-ops': ['error', { words: true, nonwords: false }],
      '@stylistic/spaced-comment': ['error', 'always', {
        line: { markers: ['*package', '!', '/', ',', '='] },
        block: { balanced: true, markers: ['*package', '!', ',', ':', '::', 'flow-include'], exceptions: ['*'] },
      }],
      '@stylistic/template-curly-spacing': ['error', 'never'],
      '@stylistic/template-tag-spacing': ['error', 'never'],
      '@stylistic/wrap-iife': ['error', 'any', { functionPrototypeMethods: true }],
      '@stylistic/yield-star-spacing': ['error', 'both'],
      // TypeScript interface/type member delimiters — consistent with semi: never
      '@stylistic/member-delimiter-style': ['error', {
        multiline: { delimiter: 'none', requireLast: false },
        singleline: { delimiter: 'comma', requireLast: false },
      }],
      // Allow inline guard+action patterns: if (cond) { stmt1; stmt2 }
      '@stylistic/max-statements-per-line': ['error', { max: 3 }],

      // TypeScript rules
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        caughtErrors: 'none',
        destructuredArrayIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],

      // Core logic rules (neostandard equivalents)
      'accessor-pairs': ['error', { setWithoutGet: true, enforceForClassMembers: true }],
      'array-callback-return': ['error', { allowImplicit: false, checkForEach: false }],
      camelcase: ['error', { allow: ['^UNSAFE_'], properties: 'never', ignoreGlobals: true }],
      'constructor-super': 'error',
      curly: ['error', 'multi-line'],
      'default-case-last': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'new-cap': ['error', { newIsCap: true, capIsNew: false, properties: true }],
      'no-array-constructor': 'error',
      'no-async-promise-executor': 'error',
      'no-caller': 'error',
      'no-eval': 'error',
      'no-extend-native': 'error',
      'no-extra-bind': 'error',
      'no-implied-eval': 'error',
      'no-iterator': 'error',
      'no-labels': ['error', { allowLoop: false, allowSwitch: false }],
      'no-lone-blocks': 'error',
      'no-loss-of-precision': 'error',
      'no-multi-str': 'error',
      'no-new': 'error',
      'no-new-func': 'error',
      'no-new-wrappers': 'error',
      'no-octal-escape': 'error',
      'no-proto': 'error',
      'no-return-assign': ['error', 'except-parens'],
      'no-self-compare': 'error',
      'no-sequences': 'error',
      'no-template-curly-in-string': 'error',
      'no-throw-literal': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-unneeded-ternary': ['error', { defaultAssignment: false }],
      'no-unreachable-loop': 'error',
      'no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true, allowTaggedTemplates: true }],
      'no-use-before-define': ['error', { functions: false, classes: false, variables: false }],
      'no-useless-call': 'error',
      'no-useless-computed-key': 'error',
      'no-useless-constructor': 'error',
      'no-useless-rename': 'error',
      'no-useless-return': 'error',
      'no-void': 'error',
      'no-with': 'error',
      'object-shorthand': ['warn', 'properties'],
      'one-var': ['error', { initialized: 'never' }],
      'prefer-const': ['error', { destructuring: 'all' }],
      'prefer-promise-reject-errors': 'error',
      'prefer-regex-literals': ['error', { disallowRedundantWrapping: true }],
      'symbol-description': 'error',
      'unicode-bom': ['error', 'never'],
      'use-isnan': ['error', { enforceForSwitchCase: true, enforceForIndexOf: true }],
      'valid-typeof': ['error', { requireStringLiterals: true }],
      yoda: ['error', 'never'],

      // eslint-plugin-n rules
      'n/handle-callback-err': ['error', '^(err|error)$'],
      'n/no-callback-literal': 'error',
      'n/no-deprecated-api': 'warn',
      'n/no-exports-assign': 'error',
      'n/no-new-require': 'error',
      'n/no-path-concat': 'error',
      'n/process-exit-as-throw': 'error',

      // eslint-plugin-promise rules
      'promise/param-names': 'error',

      // Vue-specific rules
      'vue/block-order': ['error', {
        order: ['script', 'template', 'style'],
      }],
      'vue/first-attribute-linebreak': ['error', {
        singleline: 'beside',
        multiline: 'below',
      }],
      'vue/component-name-in-template-casing': ['error', 'PascalCase', {
        registeredComponentsOnly: false,
        ignores: [
          'swiper-container', 'swiper-slide', 'lottie-player', 'primitive',
          // TanStack Form exposes its render-prop components off the form
          // instance — `<form.Field>` / `<form.Subscribe>` cannot be PascalCase.
          '/^form\\.[A-Z]/',
        ],
      }],
      'vue/max-attributes-per-line': ['error', {
        singleline: { max: 10 },
        multiline: { max: 1 },
      }],
      'vue/multi-word-component-names': 'off',
      'vue/no-unused-vars': ['error', {
        ignorePattern: '^_',
      }],
      'vue/no-v-html': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/multiline-html-element-content-newline': ['error', {
        ignoreWhenEmpty: true,
        allowEmptyLines: false,
      }],
      'vue/html-comment-content-newline': 'error',
      'vue/html-comment-indent': 'error',

      ...pluginTailwind.configs?.['recommended']?.rules,
      'better-tailwindcss/enforce-consistent-line-wrapping': 'off',
      'better-tailwindcss/enforce-shorthand-classes': 'warn',
      'better-tailwindcss/no-unregistered-classes': 'off',
      'better-tailwindcss/no-duplicate-classes': 'warn',
      'better-tailwindcss/no-unknown-classes': 'off',
    },
  },

  // `app/utils/toast.ts` wraps sonner so that errors and warnings stay on
  // screen until they are dismissed. Importing sonner directly gets the plain
  // article and a four-second error nobody reads — and it looks identical at
  // the call site, so it would be found by somebody wondering why one
  // particular message keeps vanishing. The wrapper is auto-imported: the fix
  // is always to delete the import, never to add one.
  {
    files: ['app/**/*.{ts,vue}'],
    ignores: ['app/utils/toast.ts', 'app/components/ui/sonner/**'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{
          name: 'vue-sonner',
          importNames: ['toast'],
          message: 'Use the auto-imported `toast` from app/utils/toast.ts (errors and warnings persist there). Just delete this import.',
        }],
      }],
    },
  },
)
