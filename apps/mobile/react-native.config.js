// Expo's own react-native.config.js resolves expo-modules-autolinking at load time.
// In this pnpm workspace that require fails, autolinking swallows the error, and
// the Android namespace "expo.core" is used as the import path. The class is
// expo.modules.ExpoModulesPackage.
module.exports = {
  dependencies: {
    expo: {
      platforms: {
        ios: {},
        android: {
          packageImportPath: "import expo.modules.ExpoModulesPackage;",
        },
        macos: null,
        windows: null,
      },
    },
  },
};
