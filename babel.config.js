// Babel configuration for Jest + Metro in the module.
//
// Standalone repo: all presets are installed locally in ./node_modules.
// The Babel preset handles TypeScript + Flow syntax in the RN preset's
// setup.js (which uses Flow type annotations Jest can't parse natively).
//
// react-native-worklets/plugin is omitted (the module doesn't use Reanimated).

module.exports = {
  presets: ['@react-native/babel-preset'],
};
