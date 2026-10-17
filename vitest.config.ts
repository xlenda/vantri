import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // tsconfig usa jsx "preserve" (o Next compila): nos testes o oxc gera o JSX do React para renderizar componentes.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  // .claude/ guarda worktrees de outros agentes (cópias dos testes); nunca rodam aqui.
  test: { exclude: [...configDefaults.exclude, ".claude/**"] },
});
