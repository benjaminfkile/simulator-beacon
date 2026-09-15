import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import styles from "./App.module.css";
import type { FlightSeries } from "./types.js";
import {
  M_TO_FT,
  MPS_TO_MPH,
  downsample,
  fastestBand,
  formatElapsed,
  formatElapsedFull,
  indexToX,
  niceTicks,
  xToIndex,
} from "./timelineMath.js";

export interface TimelineProps {
  flight: FlightSeries | null;
  loadingError: string | null;
  playheadIndex: number | null;
  onSeek: (index: number) => void;
  // The chart lays itself out to this width when the DOM does not report one
  // (e.g. under jsdom). Callers do not usually pass it.
  width?: number;
  height?: number;
}

const DEFAULT_HEIGHT = 200;
const AXIS_LEFT = 44;
const AXIS_RIGHT = 44;
const AXIS_TOP = 12;
const AXIS_BOTTOM = 28;
const SEEK_THROTTLE_MS = 200;

interface Readout {
  index: number;
  tMs: number;
  mph: number | null;
  ft: number | null;
}

export function Timeline(props: TimelineProps) {
  const { flight, loadingError, playheadIndex, onSeek } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState<number>(props.width ?? 640);
  const height = props.height ?? DEFAULT_HEIGHT;

  useLayoutEffect(() => {
    if (props.width) {
      setMeasuredWidth(props.width);
      return;
    }
    const el = containerRef.current;
    if (!el) return;
    const measure = (): void => {
      const w = el.clientWidth;
      if (w > 0) setMeasuredWidth(w);
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [props.width]);

  const totalWidth = Math.max(320, measuredWidth);
  const plotWidth = Math.max(1, totalWidth - AXIS_LEFT - AXIS_RIGHT);
  const plotHeight = Math.max(1, height - AXIS_TOP - AXIS_BOTTOM);

  const points = useMemo(() => flight?.points ?? [], [flight]);
  const durationMs = flight?.durationMs ?? 0;
  const hasAltitude = flight?.hasAltitude ?? false;

  const buckets = useMemo(
    () => downsample(points, plotWidth, durationMs),
    [points, plotWidth, durationMs],
  );

  const speedMaxMph = useMemo(() => {
    let m = 0;
    for (const b of buckets) if (b.speedMaxMph != null && b.speedMaxMph > m) m = b.speedMaxMph;
    return m > 0 ? m : 1;
  }, [buckets]);

  const altBounds = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const b of buckets) {
      if (b.altMinFt != null && b.altMinFt < lo) lo = b.altMinFt;
      if (b.altMaxFt != null && b.altMaxFt > hi) hi = b.altMaxFt;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1 };
    if (hi === lo) return { lo, hi: lo + 1 };
    return { lo, hi };
  }, [buckets]);

  const band = useMemo(() => fastestBand(points), [points]);

  const speedYFor = useCallback(
    (mph: number): number => {
      const frac = mph / speedMaxMph;
      return AXIS_TOP + plotHeight - frac * plotHeight;
    },
    [plotHeight, speedMaxMph],
  );

  const altYFor = useCallback(
    (ft: number): number => {
      const frac = (ft - altBounds.lo) / (altBounds.hi - altBounds.lo);
      return AXIS_TOP + plotHeight - frac * plotHeight;
    },
    [plotHeight, altBounds],
  );

  const speedPolylines = useMemo(() => {
    // Two polylines: min and max per bucket so a spike survives downsampling
    // and is drawn as a thin vertical stroke between them.
    const mins: string[] = [];
    const maxs: string[] = [];
    for (const b of buckets) {
      if (b.speedMinMph == null || b.speedMaxMph == null) continue;
      mins.push(`${AXIS_LEFT + b.x},${speedYFor(b.speedMinMph)}`);
      maxs.push(`${AXIS_LEFT + b.x},${speedYFor(b.speedMaxMph)}`);
    }
    return { min: mins.join(" "), max: maxs.join(" ") };
  }, [buckets, speedYFor]);

  const altPolyline = useMemo(() => {
    if (!hasAltitude) return "";
    const pts: string[] = [];
    for (const b of buckets) {
      if (b.altMaxFt == null) continue;
      pts.push(`${AXIS_LEFT + b.x},${altYFor(b.altMaxFt)}`);
    }
    return pts.join(" ");
  }, [buckets, altYFor, hasAltitude]);

  const speedTicks = useMemo(() => niceTicks(0, speedMaxMph, 4), [speedMaxMph]);
  const altTicks = useMemo(
    () => (hasAltitude ? niceTicks(altBounds.lo, altBounds.hi, 4) : []),
    [altBounds, hasAltitude],
  );

  const timeTicks = useMemo(() => {
    const out: { ms: number; x: number }[] = [];
    if (durationMs <= 0) return out;
    const step = 15 * 60 * 1000;
    for (let t = 0; t <= durationMs + step / 2; t += step) {
      const frac = t / durationMs;
      const x = AXIS_LEFT + Math.max(0, Math.min(plotWidth, frac * plotWidth));
      out.push({ ms: t, x });
    }
    return out;
  }, [durationMs, plotWidth]);

  const [hoverReadout, setHoverReadout] = useState<Readout | null>(null);

  const readoutForIndex = useCallback(
    (index: number): Readout | null => {
      if (!flight || points.length === 0) return null;
      const clamped = Math.max(0, Math.min(points.length - 1, index));
      const p = points[clamped]!;
      return {
        index: clamped,
        tMs: p.t,
        mph: p.speedMps != null ? p.speedMps * MPS_TO_MPH : null,
        ft: p.altitudeM != null ? p.altitudeM * M_TO_FT : null,
      };
    },
    [flight, points],
  );

  const isDraggingRef = useRef<boolean>(false);
  const movedRef = useRef<boolean>(false);
  const pendingSeekRef = useRef<number | null>(null);
  const trailingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTrailing = useCallback((): void => {
    if (trailingTimerRef.current != null) {
      clearTimeout(trailingTimerRef.current);
      trailingTimerRef.current = null;
    }
    pendingSeekRef.current = null;
  }, []);

  useEffect(() => clearTrailing, [clearTrailing]);

  // Trailing 200 ms throttle: the pointermoves inside one window fold into
  // one PATCH that carries the latest index at the end of the window
  // (simulator-beacon.md 5). Release cancels any pending trailing and fires
  // one final PATCH with the released index.
  const scheduleSeek = useCallback((index: number): void => {
    pendingSeekRef.current = index;
    if (trailingTimerRef.current == null) {
      trailingTimerRef.current = setTimeout(() => {
        trailingTimerRef.current = null;
        const idx = pendingSeekRef.current;
        pendingSeekRef.current = null;
        if (idx != null) onSeek(idx);
      }, SEEK_THROTTLE_MS);
    }
  }, [onSeek]);

  const pointerToIndex = useCallback(
    (clientX: number): number => {
      const svg = svgRef.current;
      if (!svg) return 0;
      const rect = svg.getBoundingClientRect();
      const scale = rect.width > 0 ? totalWidth / rect.width : 1;
      const localX = (clientX - rect.left) * scale;
      const inPlot = Math.max(0, Math.min(plotWidth - 1, localX - AXIS_LEFT));
      return xToIndex(points, inPlot, plotWidth, durationMs);
    },
    [points, plotWidth, durationMs, totalWidth],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>): void => {
      if (!flight || points.length === 0) return;
      const idx = pointerToIndex(e.clientX);
      setHoverReadout(readoutForIndex(idx));
      if (isDraggingRef.current) {
        movedRef.current = true;
        scheduleSeek(idx);
      }
    },
    [flight, points.length, pointerToIndex, readoutForIndex, scheduleSeek],
  );

  const onPointerLeave = useCallback((): void => {
    if (!isDraggingRef.current) setHoverReadout(null);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>): void => {
      if (!flight || points.length === 0) return;
      isDraggingRef.current = true;
      movedRef.current = false;
      try {
        (e.currentTarget as unknown as SVGElement & { setPointerCapture?: (id: number) => void }).setPointerCapture?.(e.pointerId);
      } catch {
        // jsdom / older DOMs
      }
    },
    [flight, points.length],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<SVGSVGElement>): void => {
      if (!isDraggingRef.current) return;
      const idx = pointerToIndex(e.clientX);
      isDraggingRef.current = false;
      const moved = movedRef.current;
      movedRef.current = false;
      // Release: cancel any pending trailing PATCH and send one more with the
      // released index (a click without movement is that one seek).
      clearTrailing();
      onSeek(idx);
      if (!moved) setHoverReadout(readoutForIndex(idx));
      try {
        (e.currentTarget as unknown as SVGElement & { releasePointerCapture?: (id: number) => void }).releasePointerCapture?.(e.pointerId);
      } catch {
        // ignored
      }
    },
    [pointerToIndex, onSeek, clearTrailing, readoutForIndex],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<SVGSVGElement>): void => {
      if (!flight || points.length === 0) return;
      const total = points.length;
      const anchor = playheadIndex ?? hoverReadout?.index ?? 0;
      let next: number | null = null;
      switch (e.key) {
        case "ArrowLeft":
          next = anchor - (e.shiftKey ? 10 : 1);
          break;
        case "ArrowRight":
          next = anchor + (e.shiftKey ? 10 : 1);
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = total - 1;
          break;
        default:
          return;
      }
      e.preventDefault();
      const clamped = Math.max(0, Math.min(total - 1, next));
      onSeek(clamped);
      setHoverReadout(readoutForIndex(clamped));
    },
    [flight, points.length, playheadIndex, hoverReadout, onSeek, readoutForIndex],
  );

  const activeReadout = hoverReadout ?? (playheadIndex != null ? readoutForIndex(playheadIndex) : null);
  const totalPoints = points.length;
  const playheadX =
    playheadIndex != null && totalPoints > 0 && durationMs > 0
      ? AXIS_LEFT + indexToX(points, playheadIndex, plotWidth, durationMs)
      : null;
  const hoverX =
    hoverReadout != null && totalPoints > 0 && durationMs > 0
      ? AXIS_LEFT + indexToX(points, hoverReadout.index, plotWidth, durationMs)
      : null;

  const bandRect = useMemo(() => {
    if (!band || totalPoints === 0 || durationMs <= 0) return null;
    const x1 = AXIS_LEFT + indexToX(points, band.fromIndex, plotWidth, durationMs);
    const x2 = AXIS_LEFT + indexToX(points, band.toIndex, plotWidth, durationMs);
    const w = Math.max(1, x2 - x1);
    return { x: x1, w };
  }, [band, points, plotWidth, durationMs, totalPoints]);

  const speedLegend =
    flight?.speedSource === "derived" ? "mph (derived)" : "mph";
  const altLegend = hasAltitude ? "ft" : "no altitude in this recording";

  const showChart = flight != null && totalPoints > 0 && durationMs > 0;

  return (
    <div className={styles.timelineWrap} ref={containerRef}>
      {loadingError ? (
        <div className={styles.timelineNote} data-testid="timeline-error">
          {loadingError}
        </div>
      ) : null}
      {!showChart ? (
        <div className={styles.timelineEmpty} data-testid="timeline-empty">
          no flight loaded
        </div>
      ) : (
        <svg
          ref={svgRef}
          role="slider"
          tabIndex={0}
          aria-label="Flight timeline"
          aria-valuemin={0}
          aria-valuemax={totalPoints - 1}
          aria-valuenow={playheadIndex ?? 0}
          className={styles.timelineSvg}
          width={totalWidth}
          height={height}
          viewBox={`0 0 ${totalWidth} ${height}`}
          data-testid="timeline-svg"
          data-total-width={String(totalWidth)}
          data-plot-width={String(plotWidth)}
          data-plot-left={String(AXIS_LEFT)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={onPointerLeave}
          onKeyDown={onKeyDown}
          style={{ touchAction: "none" }}
        >
          {/* Fastest 10% band */}
          {bandRect ? (
            <rect
              x={bandRect.x}
              y={AXIS_TOP}
              width={bandRect.w}
              height={plotHeight}
              className={styles.timelineBand}
              data-testid="timeline-band"
            />
          ) : null}
          {/* Speed axis ticks (left) */}
          {speedTicks.map((v) => (
            <g key={`sy-${v}`} className={styles.timelineTickGroup}>
              <line
                x1={AXIS_LEFT}
                x2={AXIS_LEFT + plotWidth}
                y1={speedYFor(v)}
                y2={speedYFor(v)}
                className={styles.timelineGrid}
              />
              <text
                x={AXIS_LEFT - 4}
                y={speedYFor(v) + 3}
                textAnchor="end"
                className={styles.timelineAxisText}
              >
                {Math.round(v)}
              </text>
            </g>
          ))}
          {/* Altitude axis ticks (right) */}
          {hasAltitude
            ? altTicks.map((v) => (
                <text
                  key={`ay-${v}`}
                  x={AXIS_LEFT + plotWidth + 4}
                  y={altYFor(v) + 3}
                  className={styles.timelineAxisText}
                >
                  {Math.round(v)}
                </text>
              ))
            : null}
          {/* Time axis ticks */}
          {timeTicks.map((t) => (
            <g key={`tx-${t.ms}`}>
              <line
                x1={t.x}
                x2={t.x}
                y1={AXIS_TOP + plotHeight}
                y2={AXIS_TOP + plotHeight + 4}
                className={styles.timelineTick}
              />
              <text
                x={t.x}
                y={AXIS_TOP + plotHeight + 16}
                textAnchor="middle"
                className={styles.timelineAxisText}
              >
                {formatElapsed(t.ms)}
              </text>
            </g>
          ))}
          {/* Speed polylines (accent) */}
          <polyline
            points={speedPolylines.min}
            className={styles.timelineSpeed}
            fill="none"
            data-testid="timeline-speed-min"
          />
          <polyline
            points={speedPolylines.max}
            className={styles.timelineSpeed}
            fill="none"
            data-testid="timeline-speed-max"
          />
          {/* Altitude polyline (muted) */}
          {hasAltitude ? (
            <polyline
              points={altPolyline}
              className={styles.timelineAlt}
              fill="none"
              data-testid="timeline-alt"
            />
          ) : null}
          {/* Legends */}
          <text
            x={AXIS_LEFT}
            y={AXIS_TOP - 2}
            className={styles.timelineLegendSpeed}
            data-testid="timeline-speed-legend"
          >
            {speedLegend}
          </text>
          <text
            x={AXIS_LEFT + plotWidth}
            y={AXIS_TOP - 2}
            textAnchor="end"
            className={styles.timelineLegendAlt}
            data-testid="timeline-alt-legend"
          >
            {altLegend}
          </text>
          {/* Hover line */}
          {hoverX != null ? (
            <line
              x1={hoverX}
              x2={hoverX}
              y1={AXIS_TOP}
              y2={AXIS_TOP + plotHeight}
              className={styles.timelineHover}
              data-testid="timeline-hover"
            />
          ) : null}
          {/* Playhead */}
          {playheadX != null ? (
            <g data-testid="timeline-playhead">
              <line
                x1={playheadX}
                x2={playheadX}
                y1={AXIS_TOP}
                y2={AXIS_TOP + plotHeight}
                className={styles.timelinePlayhead}
              />
              <circle
                cx={playheadX}
                cy={AXIS_TOP}
                r={4}
                className={styles.timelinePlayheadHandle}
              />
            </g>
          ) : null}
        </svg>
      )}
      <div className={styles.timelineReadout} data-testid="timeline-readout">
        {activeReadout ? (
          <>
            <span data-testid="readout-time">
              {formatElapsedFull(activeReadout.tMs)}
            </span>
            <span data-testid="readout-mph">
              {activeReadout.mph == null
                ? "no speed"
                : `${activeReadout.mph.toFixed(1)} mph`}
            </span>
            <span data-testid="readout-ft">
              {activeReadout.ft == null ? "no altitude" : `${Math.round(activeReadout.ft)} ft`}
            </span>
            <span data-testid="readout-index">
              point {activeReadout.index + 1} of {totalPoints}
            </span>
          </>
        ) : (
          <span className={styles.timelineNote}>hover to inspect</span>
        )}
      </div>
    </div>
  );
}
