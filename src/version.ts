/**
 * Package metadata (name and version) read from package.json
 */

import pkg from "../package.json" with { type: "json" };

export const PACKAGE_NAME: string = pkg.name;
export const PACKAGE_VERSION: string = pkg.version;
