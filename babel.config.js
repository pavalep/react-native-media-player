// Phase 34: Babel configuration for Jest + Metro in the module.
//
// The module is a standalone NPM package, but during development we
// run Jest against the consumer-app's node_modules (sibling dir).
// The Babel preset handles TypeScript + Flow syntax in the RN preset's
// setup.js (which uses Flow type annotations Jest can't parse
// natively).
//
// We use the same @react-native/babel-preset as the consumer app so
// transforms are identical across the dev / publish / consumer-app
// boundaries. react-native-worklets/plugin is omitted (the module
// doesn't use Reanimated).

const consumerDep = (name) =>
  require.resolve(name, {
    paths: [require('path').resolve(__dirname, '..', 'MOBILE_APP_REACT_NATIVE')],
  });

module.exports = {
  presets: [consumerDep('@react-native/babel-preset')],
};
