import { defineConfig } from "tsup";

// Dual ESM + CJS build with type declarations. JSON schema imports are inlined
// into the bundles by esbuild, so the package has no runtime file I/O and works
// identically whether imported (ESM) or required (CJS).
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  // LangChain is an optional peer the instrumentor imports dynamically at
  // runtime — never bundle it into the SDK; it's resolved in the user's app.
  external: [/^@langchain\//],
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
