const globals = require('globals');

// Project conventions (kept loose intentionally):
// - Frontend modules in public/js/ (except charter.js) are ES modules with explicit imports.
// - charter.js is still a classic script that shares globals via window.
// - Server code uses CommonJS in Node.
// - Goal: catch real bugs (typos, ===, unused) without forcing a stylistic rewrite.

const sharedRules = {
  'no-undef': 'error',
  'no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }],
  'no-redeclare': ['error', { builtinGlobals: false }],
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-cond-assign': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-unreachable': 'error',
  'no-useless-escape': 'warn',
  'eqeqeq': ['warn', 'smart'],
  'no-var': 'warn',
  'prefer-const': ['warn', { destructuring: 'all' }],
};

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'package-lock.json',
      'data/**',
      'league-hub/**',
      'public/sw.js',
    ],
  },

  // Frontend ES modules (everything in public/js/ except charter.js)
  {
    files: ['public/js/**/*.js'],
    ignores: ['public/js/charter.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      ...sharedRules,
      'no-console': ['warn', { allow: ['warn', 'error', 'group', 'groupEnd'] }],
    },
  },

  // charter.js stays a classic script; reads S / log / DEBUG via window
  {
    files: ['public/js/charter.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        S: 'readonly',
        log: 'readonly',
        DEBUG: 'readonly',
      },
    },
    rules: {
      ...sharedRules,
      'no-console': ['warn', { allow: ['warn', 'error', 'group', 'groupEnd'] }],
    },
  },

  // Node server + routes + cron
  {
    files: ['server.js', 'routes/**/*.js', 'cron.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: sharedRules,
  },

  // ESLint config file itself
  {
    files: ['eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: sharedRules,
  },
];
