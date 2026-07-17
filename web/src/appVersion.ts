/** Build-time version from the workspace-root package.json; "dev" when the
 *  bundle-time define is absent (unit tests run the sources directly). */
export const APP_VERSION = typeof __APP_VERSION__ === "undefined" ? "dev" : __APP_VERSION__;
