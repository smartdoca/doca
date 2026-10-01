import sdkPackage from "../package.json" with { type: "json" };

/** SDK version implemented by this package. It follows package.json. */
export const PLUGIN_SDK_VERSION: string = sdkPackage.version;
