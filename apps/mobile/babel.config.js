/**
 * Babel configuration.
 *
 * Plain `babel-preset-expo`. Every native dependency is pinned to the version in
 * `expo/bundledNativeModules.json`, which is the authoritative pairing for the SDK
 * — so Hermes and the React Native source agree about which syntax is supported
 * and no downleveling plugins are needed.
 *
 * Worth knowing if a `private properties are not supported` error ever appears
 * from `hermesc`: it means a native package has drifted from the SDK's pairing,
 * not that a Babel plugin is missing. Check `bundledNativeModules.json` first
 * (`npx expo install --check`), rather than adding class-feature transforms —
 * those run before presets and will then trip over TypeScript `declare` fields.
 */
module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-worklets/plugin'],
  };
};
