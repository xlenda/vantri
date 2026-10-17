import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      // .next e as pastas de build paralelas (NEXT_DIST_DIR=.next-*), como no .gitignore.
      ".next*/**",
      // Worktrees de outros agentes (cópias do repositório) e o banco local de desenvolvimento.
      ".claude/**",
      ".data/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
