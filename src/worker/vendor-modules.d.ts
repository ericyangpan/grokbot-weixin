/** Wrangler's default Text rule serves `*.txt` as a string. The file is not executed. */
declare module "*.txt" {
  const contents: string;
  export default contents;
}

/** Wrangler's default Data rule serves `*.bin` as bytes. This is not a compiled wasm module. */
declare module "*.bin" {
  const contents: ArrayBuffer;
  export default contents;
}
