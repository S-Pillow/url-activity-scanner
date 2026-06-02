/**
 * CSS Module mock for Jest.
 *
 * Returns a Proxy that echoes any accessed property name as the value,
 * so className={styles.myClass} becomes className="myClass" in tests.
 * This makes class-name assertions readable without loading actual CSS.
 */
const styleMock = new Proxy(
  {},
  { get: (_target, prop) => (typeof prop === "string" ? prop : undefined) }
);

export default styleMock;
