import { installSilkLibrary } from "../core/history-assets.js";

import silkGlue from "./vendor/silk-glue.txt";
import silkWasm from "./vendor/silk.wasm.bin";

/**
 * Serve silk-wasm as static bytes. Do not import the package's JS entry:
 * that build targets Node (`fs`, `import("module")`) and wrangler's default
 * `*.wasm` rule would compile the module inside this isolate. The poll path
 * never calls `decode`. The history page does, in the browser.
 */
installSilkLibrary(silkGlue, silkWasm);
