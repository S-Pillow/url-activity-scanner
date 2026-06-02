/**
 * ForgeForward Tools — /tools index page
 *
 * Root cause fix: AIPF-009 placed the tool directory on src/app/page.tsx
 * (route "/"), leaving src/app/tools/ with no index page. Any visit to
 * https://forgeforward.app/tools therefore returned a 404 and the URL
 * Activity Scanner card was never visible.
 *
 * This file is the missing src/app/tools/page.tsx (route "/tools").
 * It is identical in purpose to the root home page but lives at the
 * expected public path.
 */
import type { Metadata } from "next";
import Link from "next/link";
import styles from "../page.module.css";

export const metadata: Metadata = {
  title: "ForgeForward Tools",
  description: "Internal security and operations utilities built by ForgeForward.",
};

const TOOLS = [
  {
    slug: "url-activity-scanner",
    title: "URL Activity Scanner",
    description:
      "Check whether suspicious URLs appear active without viewing, " +
      "rendering, downloading, or storing content.",
    badge: "MVP · Prototype",
  },
] as const;

export default function ToolsPage() {
  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <h1 className={styles.siteTitle}>ForgeForward Tools</h1>
        <p className={styles.subtitle}>
          Internal security and operations utilities for the RTMS team.
        </p>
      </header>

      <section aria-label="Available tools">
        <ul className={styles.toolGrid}>
          {TOOLS.map((tool) => (
            <li key={tool.slug}>
              <Link
                href={`/tools/${tool.slug}`}
                className={styles.toolCard}
                aria-label={`Open ${tool.title}`}
              >
                <div className={styles.toolCardInner}>
                  <div className={styles.toolBadge}>{tool.badge}</div>
                  <h2 className={styles.toolTitle}>{tool.title}</h2>
                  <p className={styles.toolDescription}>{tool.description}</p>
                  <span className={styles.toolArrow} aria-hidden="true">
                    →
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
