// Build the final single-file userscript from src/.
//
// Strategy (strangler-fig migration): src/main.js starts as the whole legacy
// body and is progressively split into modules under src/. While it still
// contains its own IIFE and no imports, esbuild's bundle is a no-op wrapper,
// so we detect that case and emit a byte-faithful concat to prove the
// pipeline changes nothing. Once main.js imports real modules, esbuild
// bundles them into one IIFE.
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "fs";

const meta = readFileSync("src/meta.txt", "utf8");
const main = readFileSync("src/main.js", "utf8");
const OUT = "PikPak_Assistant.user.js";

const usesModules = /^\s*import\s.+from\s/m.test(main);

if (!usesModules) {
  // Stage 0: no module graph yet — main.js is the self-contained legacy body.
  // Emit header + body verbatim so the output equals the pre-refactor file.
  writeFileSync(OUT, meta + main);
  console.log("built (concat, legacy body) -> " + OUT);
} else {
  const result = await build({
    entryPoints: ["src/main.js"],
    bundle: true,
    format: "iife",
    target: "es2020",
    charset: "utf8",
    legalComments: "none",
    loader: { ".css": "text" },
    write: false,
  });
  writeFileSync(OUT, meta + result.outputFiles[0].text);
  console.log("built (esbuild bundle) -> " + OUT);
}
