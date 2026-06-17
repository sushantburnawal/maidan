module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/**/*.spec.ts', '<rootDir>/**/*.e2e-spec.ts'],
  moduleNameMapper: {
    '^@maidan/shared$': '<rootDir>/../../packages/shared/src'
  }
};
