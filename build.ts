/**
 * Production build: one compiled binary at `dist/lgtm`.
 *
 * This calls the Bun.build() JS API directly, with compile.outfile set, not
 * the `bun build --compile` CLI. The CLI form silently ignores bundler
 * plugins (an open Bun bug — see docs/spec/design.md, "Build and
 * distribution"), so bun-plugin-tailwind would never run and the embedded
 * SPA would compile unstyled with no error to catch it. Do not "simplify"
 * this back to a shell-out; that regression is exactly what this file exists
 * to prevent.
 */
import tailwind from "bun-plugin-tailwind";

const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  compile: {
    outfile: "dist/lgtm",
  },
  plugins: [tailwind],
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});

if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exit(1);
}

for (const output of result.outputs) {
  console.log(`${output.path}  ${(output.size / 1024).toFixed(1)} KB`);
}
