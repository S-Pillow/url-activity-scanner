import type { Config } from "jest";

/**
 * Jest configuration for the URL Activity Scanner project.
 *
 * Environment strategy:
 *   - Default: "node" — required by security module tests that use Node.js
 *     built-ins (http, https, dns). Existing tests have no @jest-environment
 *     annotation and inherit this default.
 *   - Per-file override: UI component test files declare
 *     /** @jest-environment jsdom *\/ in their docblock and receive a full
 *     browser-like environment including window, document, and localStorage.
 *
 * Transform strategy:
 *   - All .ts and .tsx files are processed by ts-jest.
 *   - ts-jest receives an inline tsconfig override that sets jsx: "react-jsx"
 *     (needed for .tsx) and keeps module: "CommonJS" (needed for Jest).
 *   - The main tsconfig.json has jsx: "preserve" for the Next.js compiler;
 *     the override here does not affect Next.js's own compilation pass.
 *
 * CSS Modules strategy:
 *   - .module.css files are mapped to a simple identity mock so that
 *     CSS class names are stable strings in component tests.
 */
const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.{ts,tsx}"],
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          jsx: "react-jsx",
          module: "CommonJS",
          moduleResolution: "node",
          esModuleInterop: true,
        },
      },
    ],
  },
  moduleNameMapper: {
    // Return an object where every accessed key echoes the key name,
    // so className={styles.myClass} becomes className="myClass" in tests.
    "\\.module\\.css$": "<rootDir>/src/__mocks__/styleMock.ts",
  },
  setupFilesAfterEnv: ["<rootDir>/src/setupTests.ts"],
  collectCoverageFrom: [
    "src/**/*.{ts,tsx}",
    "!src/**/__tests__/**",
    "!src/setupTests.ts",
    "!src/__mocks__/**",
  ],
};

export default config;
