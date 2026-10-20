import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["out/", "dist/", "dist-test/", "node_modules/", "eslint.config.js", "qa-results/", "test-results/", "fixtures/*.json", "src/shared/contracts/generated/"] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
      "@typescript-eslint/no-confusing-void-expression": "off",
    },
  },
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat["recommended-latest"]],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["src/main/**/*.ts", "src/preload/**/*.ts", "*.config.ts", "qa/**/*.{ts,js}", "fixtures/**/*.ts", "perf/**/*.{ts,mjs}"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["qa/selftest/app/pages.js"],
    languageOptions: { globals: globals.browser },
  },
);
