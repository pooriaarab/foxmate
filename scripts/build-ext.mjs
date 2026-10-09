// Builds extension/ into dist-ext/: esbuild bundles the page entry scripts
// (with src/ and the fox primitives), and the other files are copied. It
// stops when the manifest version is not the package.json version, so AMO
// signs the version that npm publishes.
import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
if (manifest.version !== pkg.version) {
  console.error(`extension/manifest.json has version ${manifest.version}, but package.json has ${pkg.version}. Make them equal.`);
  process.exit(1);
}

const ENTRIES = ["background.js", "sidebar.js", "browser-model.js"];
// foxshield's scanHtml needs linkedom, which only Node uses. The extension
// scans live pages with scanDocument, so linkedom becomes a stub that throws.
const noLinkedom = {
  name: "no-linkedom",
  setup(b) {
    b.onResolve({ filter: /^linkedom$/ }, () => ({ path: "linkedom", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export function parseHTML() { throw new Error('linkedom is not in the extension'); }" }));
  },
};
rmSync("dist-ext", { recursive: true, force: true });
await build({
  entryPoints: ENTRIES.map((f) => `extension/${f}`),
  external: ["./browser-model.js"],
  outdir: "dist-ext",
  bundle: true,
  format: "esm",
  target: "firefox153",
  logLevel: "warning",
  plugins: [noLinkedom],
});
for (const file of readdirSync("extension").filter((f) => !f.endsWith(".js"))) cpSync(`extension/${file}`, `dist-ext/${file}`, { recursive: true });
// ONNX Runtime's WASM files for the in-browser models go to dist-ext/ort/
// (foxmind's default path), because MV3 allows no remote code.
const ort = join(dirname(dirname(realpathSync("node_modules/@huggingface/transformers"))), "onnxruntime-web", "dist");
mkdirSync("dist-ext/ort");
for (const file of ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"]) cpSync(join(ort, file), join("dist-ext/ort", file));
console.log(`Built dist-ext/ (version ${pkg.version}).`);
