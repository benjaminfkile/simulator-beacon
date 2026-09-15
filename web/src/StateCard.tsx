import { useEffect, useState } from "react";
import styles from "./App.module.css";
import { Timeline } from "./Timeline.js";
import type { ControlState, FlightSeries, Speed, YearItem } from "./types.js";

export interface StateCardProps {
  state: ControlState | null;
  years: YearItem[];
  selectedYear: number | "";
  selectedSpeed: Speed;
  selectedLoop: boolean;
  onYearChange: (v: number | "") => void;
  onSpeedChange: (v: Speed) => void;
  onLoopChange: (v: boolean) => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onSeek: (index: number) => void;
  errorLine: string | null;
  busy: "" | "start" | "stop" | "restart";
  speedOptions: readonly Speed[];
  flight: FlightSeries | null;
  flightError: string | null;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "none";
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

function socketPillClass(state: string | null | undefined): string {
  switch (state) {
    case "connected":
      return `${styles.pill} ${styles.pillOk}`;
    case "connecting":
    case "reconnecting":
      return `${styles.pill} ${styles.pillWarn}`;
    case "disconnected":
      return `${styles.pill} ${styles.pillErr}`;
    default:
      return styles.pill;
  }
}

function runPillClass(status: string): string {
  switch (status) {
    case "running":
      return `${styles.pill} ${styles.pillOk}`;
    case "loading":
      return `${styles.pill} ${styles.pillWarn}`;
    case "failed":
      return `${styles.pill} ${styles.pillErr}`;
    default:
      return styles.pill;
  }
}

export function StateCard(props: StateCardProps) {
  const {
    state,
    years,
    selectedYear,
    selectedSpeed,
    selectedLoop,
    onYearChange,
    onSpeedChange,
    onLoopChange,
    onStart,
    onStop,
    onRestart,
    onSeek,
    errorLine,
    busy,
    speedOptions,
    flight,
    flightError,
  } = props;

  // Elapsed ticks locally to update the counter without waiting for the next
  // poll; it re-anchors to `run.startedAt` on every state refresh.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(h);
  }, []);

  const beacon = state?.beacon ?? null;
  const run = state?.run ?? null;
  const total = run?.total ?? 0;
  const index = run?.index ?? 0;
  const startedMs = run?.startedAt ? Date.parse(run.startedAt) : NaN;
  const elapsedMs = Number.isFinite(startedMs) ? now - startedMs : NaN;

  // Start reads "Resume" when the run is stopped mid-recording for the year
  // the operator has selected (the row's index is inside the recording but
  // not yet the last point). Otherwise it reads "Start" (simulator-beacon.md
  // 5). Restart is unchanged; Stop always reads "Pause".
  const startResumes =
    run != null &&
    run.status === "stopped" &&
    typeof selectedYear === "number" &&
    run.year === selectedYear &&
    run.index > 0 &&
    run.total > 0 &&
    run.index < run.total;
  const startLabel = startResumes ? "Resume" : "Start";
  const startBusyLabel = startResumes ? "Resuming…" : "Starting…";

  // The chart's playhead only makes sense when the run's year matches the
  // selection and the run has a total: elsewhere the year on the row and the
  // year in the chart do not line up.
  const showPlayhead =
    run != null &&
    typeof selectedYear === "number" &&
    run.year === selectedYear &&
    run.total > 0;

  return (
    <section
      className={styles.card}
      role="region"
      aria-label="Simulator beacon control"
    >
      {beacon?.revoked ? (
        <div className={styles.banner} role="alert">
          Beacon key revoked: the API is refusing this beacon.
        </div>
      ) : null}

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Beacon</h2>
        <dl className={styles.grid}>
          <dt className={styles.label}>Name</dt>
          <dd className={styles.value} data-testid="beacon-name">
            {beacon?.name ?? "none"}
          </dd>
          <dt className={styles.label}>Status</dt>
          <dd className={styles.value}>
            <span className={styles.pill} data-testid="beacon-active">
              {beacon == null
                ? "no leader"
                : beacon.isActive
                  ? "Active"
                  : "Spare"}
            </span>
          </dd>
          <dt className={styles.label}>Live event</dt>
          <dd className={styles.value} data-testid="beacon-live-event">
            {beacon?.liveEventId ?? "no live event"}
          </dd>
          <dt className={styles.label}>Socket</dt>
          <dd className={styles.value}>
            <span
              className={socketPillClass(beacon?.socketState)}
              data-testid="beacon-socket"
            >
              {beacon?.socketState ?? "none"}
            </span>
          </dd>
          <dt className={styles.label}>Last delivered</dt>
          <dd className={styles.value} data-testid="beacon-last-delivered">
            {beacon?.lastDeliveredSeqLocal ?? "none"}
          </dd>
          <dt className={styles.label}>Receipt latency</dt>
          <dd className={styles.value} data-testid="beacon-latency">
            {beacon?.lastReceiptLatencyMs == null
              ? "none"
              : `${beacon.lastReceiptLatencyMs} ms`}
          </dd>
          <dt className={styles.label}>Heartbeat age</dt>
          <dd className={styles.value} data-testid="beacon-heartbeat-age">
            {beacon?.heartbeatAge == null ? "none" : `${beacon.heartbeatAge} s`}
          </dd>
        </dl>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Run</h2>
        <dl className={styles.grid}>
          <dt className={styles.label}>Status</dt>
          <dd className={styles.value}>
            <span
              className={runPillClass(run?.status ?? "stopped")}
              data-testid="run-status"
            >
              {run?.status ?? "none"}
            </span>
            {run && run.cycles > 0 ? (
              <span
                className={styles.cycle}
                data-testid="run-cycle"
              >{` cycle ${run.cycles}`}</span>
            ) : null}
          </dd>
          <dt className={styles.label}>Year</dt>
          <dd className={styles.value} data-testid="run-year">
            {run?.year ?? "none"}
          </dd>
          <dt className={styles.label}>Speed</dt>
          <dd className={styles.value} data-testid="run-speed">
            {run == null ? "none" : `${run.speed}x`}
          </dd>
          <dt className={styles.label}>Progress</dt>
          <dd className={styles.value} data-testid="run-progress">
            {`${index} / ${total}`}
          </dd>
          <dt className={styles.label}>Elapsed</dt>
          <dd className={styles.value} data-testid="run-elapsed">
            {Number.isFinite(elapsedMs) ? formatDuration(elapsedMs) : "none"}
          </dd>
          {run != null && run.nextFixInMs != null ? (
            <>
              <dt className={styles.label}>Next fix in</dt>
              <dd className={styles.value} data-testid="run-next-fix">
                {`${run.nextFixInMs} ms`}
              </dd>
            </>
          ) : null}
          <dt className={styles.label}>Last error</dt>
          <dd className={styles.value} data-testid="run-error">
            {run?.lastError ?? "none"}
          </dd>
        </dl>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Timeline</h2>
        <Timeline
          flight={flight}
          loadingError={flightError}
          playheadIndex={showPlayhead ? index : null}
          onSeek={onSeek}
        />
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Controls</h2>
        <div className={styles.controls}>
          <label className={styles.controlField}>
            <span className={styles.controlLabel}>Year</span>
            <select
              className={styles.select}
              data-testid="year-select"
              value={selectedYear === "" ? "" : String(selectedYear)}
              onChange={(e) => {
                const v = e.target.value;
                onYearChange(v === "" ? "" : Number(v));
              }}
              disabled={years.length === 0}
            >
              {years.length === 0 ? <option value="">No years</option> : null}
              {years.map((y) => (
                <option key={y.year} value={String(y.year)}>
                  {y.year} {y.name} ({y.pointCount} points)
                </option>
              ))}
            </select>
          </label>
          <label className={styles.controlField}>
            <span className={styles.controlLabel}>Speed</span>
            <select
              className={styles.select}
              data-testid="speed-select"
              value={String(selectedSpeed)}
              onChange={(e) => onSpeedChange(Number(e.target.value) as Speed)}
            >
              {speedOptions.map((s) => (
                <option key={s} value={String(s)}>
                  {s}x
                </option>
              ))}
            </select>
          </label>
          <label className={styles.controlField}>
            <span className={styles.controlLabel}>Loop</span>
            <span className={styles.switch}>
              <input
                type="checkbox"
                data-testid="loop-switch"
                checked={selectedLoop}
                onChange={(e) => onLoopChange(e.target.checked)}
              />
              <span className={styles.switchLabel}>
                {selectedLoop ? "on" : "off"}
              </span>
            </span>
          </label>
        </div>
        <div className={styles.buttons}>
          <button
            className={`${styles.button} ${styles.buttonPrimary}`}
            data-testid="btn-start"
            onClick={onStart}
            disabled={busy !== "" || selectedYear === ""}
          >
            {busy === "start" ? startBusyLabel : startLabel}
          </button>
          <button
            className={styles.button}
            data-testid="btn-stop"
            onClick={onStop}
            disabled={busy !== ""}
          >
            {busy === "stop" ? "Pausing…" : "Pause"}
          </button>
          <button
            className={styles.button}
            data-testid="btn-restart"
            onClick={onRestart}
            disabled={busy !== ""}
          >
            {busy === "restart" ? "Restarting…" : "Restart"}
          </button>
        </div>
        {errorLine ? (
          <p className={styles.errorLine} data-testid="error-line">
            {errorLine}
          </p>
        ) : null}
      </div>
    </section>
  );
}
