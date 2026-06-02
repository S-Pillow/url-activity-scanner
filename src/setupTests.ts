/**
 * Jest global test setup.
 *
 * Imports @testing-library/jest-dom to add custom DOM matchers such as
 * toBeInTheDocument(), toBeDisabled(), toHaveValue(), etc. to the global
 * `expect` object.
 *
 * This file runs after the test framework is installed but before each
 * test file, for both "node" and "jsdom" environments. In the "node"
 * environment, the matchers are registered but never invoked (no DOM exists),
 * so there is no conflict with existing security module tests.
 */
import "@testing-library/jest-dom";
