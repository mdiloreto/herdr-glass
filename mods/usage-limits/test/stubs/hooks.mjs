import { registerHooks } from "node:module";

const HOST = new URL("./host.mjs", import.meta.url).href;
const HOST_MODULES = new Set(["gpui-kit", "gpui-base", "herdr"]);

registerHooks({
  resolve(spec, context, next) {
    return HOST_MODULES.has(spec) ? { url: HOST, shortCircuit: true } : next(spec, context);
  },
});
