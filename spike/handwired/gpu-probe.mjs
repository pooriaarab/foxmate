// Is WebGPU there for the extension, by default and with the prefs on?
//   node spike/handwired/gpu-probe.mjs
import { launch } from "create-foxkit/e2e";
import { EXTENSION } from "../../cli/driver.mjs";
const probe = `(async () => { try { const a = navigator.gpu && await navigator.gpu.requestAdapter(); return { gpu: !!navigator.gpu, adapter: !!a, info: a ? String(a.info?.vendor) + "/" + String(a.info?.architecture) : null }; } catch (e) { return { gpu: !!navigator.gpu, error: String(e) }; } })()`;
for (const prefs of [{}, { "dom.webgpu.enabled": true }, { "dom.webgpu.enabled": true, "gfx.webgpu.ignore-blocklist": true }]) {
  const fox = await launch({ extension: EXTENSION, headless: true, prefs });
  const ext = await fox.openExtensionPage("app.html");
  console.log(JSON.stringify(prefs), "extension page:", JSON.stringify(await ext.evaluate(probe)));
  await fox.close();
}
