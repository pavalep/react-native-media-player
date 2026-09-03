// Phase 34: Jest configuration for @simba/react-native-media-player.
//
// Uses the consumer app's node_modules (sibling directory) to avoid
// duplicating ~1GB of React Native + Jest deps inside the module.
//
// preset: @react-native/jest-preset (official RN preset)
// testMatch: <rootDir>/src/**/__tests__/**/*.{ts,tsx}
// setupFiles: jest.setup.ts (installs NativeModules.MpvPlayerModule mock)
// transformIgnorePatterns: allow Babel to transpile @react-native + react-native

const path = require('path');

function consumerDep(name) {
  return path.resolve(
    __dirname,
    '..',
    'MOBILE_APP_REACT_NATIVE',
    'node_modules',
    name,
  );
}

module.exports = {
  preset: consumerDep('@react-native/jest-preset'),
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
    '^@simba/react-native-media-player$': '<rootDir>/src/index.ts',
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
    // Phase 33's JUnit / Robolectric tests + the Phase 39 instrumented
    // tests, so excluding them from the unit-test coverage keeps the
    // threshold meaningful.
    '!src/components/PlayerRoot.tsx',
    '!src/components/PlayerSurface.tsx',
  ],
  coverageThreshold: {
    global: {
      // Spec §Phase 34.8: aim for ≥70% coverage. The function
      // threshold is intentionally lower (60%) because DefaultControls
      // has many small render-helper functions (formatTime, position
      // math, scrubber gesture handlers) that are exercised end-to-end
      // in Phase 39 instrumented tests but not all of them are
      // callable from a unit-test render tree.
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
