import * as esbuild from "npm:esbuild";
import { denoPlugins } from "jsr:@luca/esbuild-deno-loader";

await esbuild.build({
  plugins: [...denoPlugins()],
  entryPoints: ["job.ts"],
  outfile: "dist/job.bundle.js",
  bundle: true,
  format: "esm",
  target: "es2022",
});

await esbuild.stop();
