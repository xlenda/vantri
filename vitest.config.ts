import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  // .claude/ guarda worktrees de outros agentes (cópias dos testes); nunca rodam aqui.
  test: { exclude: [...configDefaults.exclude, ".claude/**"] },
});
