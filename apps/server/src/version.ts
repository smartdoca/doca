import hostPackage from "../../../package.json" with { type: "json" };

export const HOST_VERSION: string = hostPackage.version;
