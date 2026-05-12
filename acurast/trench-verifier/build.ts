// ============================================================================
// build.ts — bundles verifier.ts (+ combat_engine.js + trench_items.json)
// into a single ESM file for Acurast NodeJSWithBundle deployment.
//
// Run from this directory:
//   deno run -A build.ts
//
// Output: dist/trench_verifier.bundle.js
// ============================================================================
import * as esbuild from "npm:esbuild";
import { denoPlugins } from "jsr:@luca/esbuild-deno-loader";

await esbuild.build({
  plugins: [...denoPlugins()],
  entryPoints: ["verifier.ts"],
  outfile: "dist/trench_verifier.bundle.js",
  bundle: true,
  format: "esm",
  target: "es2022",
  // The JSON import attribute (`with { type: "json" }`) is handled natively
  // by esbuild — the items catalog gets inlined as a const.
});

await esbuild.stop();
console.log("built dist/trench_verifier.bundle.js");
