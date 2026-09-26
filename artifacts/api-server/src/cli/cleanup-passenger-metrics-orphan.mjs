import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (initialError) {
      if (!specifier.startsWith(".") || /\.[^/]+$/.test(specifier)) throw initialError;
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        try {
          return nextResolve(candidate, context);
        } catch {
          // Try the next TypeScript ESM resolution candidate.
        }
      }
      throw initialError;
    }
  },
});

await import("./cleanup-passenger-metrics-orphan.ts");