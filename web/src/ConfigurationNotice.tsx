import styles from "./App.module.css";

export interface ConfigurationNoticeProps {
  missing: string[];
}

export function ConfigurationNotice(props: ConfigurationNoticeProps) {
  return (
    <div className={styles.app}>
      <section className={styles.card} role="region" aria-label="Configuration">
        <h1 className={styles.configHeading}>Configuration required</h1>
        <p style={{ margin: 0, color: "var(--color-ink-muted)" }}>
          The control page cannot start because these environment variables are
          not set in this build:
        </p>
        <ul className={styles.configList} data-testid="missing-list">
          {props.missing.map((k) => (
            <li key={k}>{k}</li>
          ))}
        </ul>
        <p style={{ margin: 0, color: "var(--color-ink-muted)" }}>
          Set every listed key in the Vercel project (or a local <code>.env</code>) and
          redeploy.
        </p>
      </section>
    </div>
  );
}
