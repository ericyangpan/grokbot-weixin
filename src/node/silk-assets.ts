import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { installSilkLibrary } from "../core/history-assets.js";

const require = createRequire(import.meta.url);

/** Load silk-wasm's files for the history page. Ingest still uses `decodeSilkPcm`. */
export function installNodeSilkLibrary(): void {
  const root = dirname(require.resolve("silk-wasm/package.json"));
  installSilkLibrary(readFileSync(join(root, "lib/index.mjs")), readFileSync(join(root, "lib/silk.wasm")));
}

installNodeSilkLibrary();
