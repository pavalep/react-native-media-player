// Jest configuration for @simba-dev/react-native-media-player.
//
// Standalone repo: all dev dependencies (preset, react, react-native,
// typescript, jest, etc.) are installed locally in ./node_modules.
// No references to the consumer app's node_modules — that was the V11
// monorepo layout, which would break CI in this standalone repo.
//
// preset: @react-native/jest-preset (official RN preset, installed locally)
// testMatch: <rootDir>/src/**/__tests__/**/*.{ts,tsx}
// setupFilesAfterEnv: jest.setup.ts (installs NativeModules.MpvPlayerModule mock)
// transformIgnorePatterns: allow Babel to transpile @react-native + react-native

module.exports = {
  preset: '@react-native/jest-preset',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  testMatch: [
    '<rootDir>/src/**/__tests__/**/*.{ts,tsx}',
    '<rootDir>/src/**/?(*.)+(spec|test).{ts,tsx}',
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/src/README.example.tsx',
  ],
  transformIgnorePatterns: [
    'node_modules/(?!(@react-native|react-native|@testing-library)/)',
  ],
  moduleNameMapper: {
    '^@simba-dev/react-native-media-player$': '<rootDir>/src/index.ts',
  },
  setupFiles: [],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/index.ts',
    '!src/README.example.tsx',
    // PlayerRoot.tsx and PlayerSurface.tsx wrap the native view
    // manager (MpvPlayerView), which doesn't have a unit-test mock
    // (it requires an Android UI hierarchy). They are exercised in
    // instrumented tests (Robolectric / Espresso) — see the V12
    // QA test matrix for those coverage paths.
    '!src/components/PlayerRoot.tsx',
    '!src/components/PlayerSurface.tsx',
  ],
  coverageThreshold: {
    global: {
      statements: 70,
      branches: 60,
      functions: 60,
      lines: 70,
    },
  },
  coverageReporters: ['text', 'lcov', 'json-summary'],
  testEnvironment: 'node',
  rootDir: __dirname,
};
