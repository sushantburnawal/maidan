module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: ['./apps/api/tsconfig.json', './packages/shared/tsconfig.json'],
    sourceType: 'module',
    tsconfigRootDir: __dirname
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  env: {
    es2022: true,
    jest: true,
    node: true
  },
  ignorePatterns: [
    'dist/',
    'coverage/',
    'node_modules/',
    'apps/ai/.venv/',
    'apps/ai/.ruff_cache/'
  ]
};
