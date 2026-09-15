import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { Timeline } from "../src/Timeline.js";
import {
  downsample,
  indexToX,
  xToIndex,
  MPS_TO_MPH,
} from "../src/timelineMath.js";
import type { FlightSeries } from "../src/types.js";

function makeFlight(pointCount = 100): FlightSeries {
  const points = Array.from({ length: pointCount }, (_, i) => ({
    i,
    t: i * 1000,
    lat: 40 + i * 0.0001,
    lng: -74 + i * 0.0001,
    speedMps: 10 + (i % 10),
    altitudeM: 100 + i,
  }));
  return {
    year: 2025,
    eventId: 7,
    name: "WMSFO 2025",
    pointCount,
    firstRecordedAt: "2025-12-22T01:00:00.000Z",
    lastRecordedAt: new Date(Date.parse("2025-12-22T01:00:00.000Z") + (pointCount - 1) * 1000).toISOString(),
    durationMs: (pointCount - 1) * 1000,
    hasAltitude: true,
    speedSource: "recorded",
    points,
  };
}

describe("timelineMath", () => {
  it("indexToX and xToIndex round-trip within one point across the width", () => {
    const flight = makeFlight(500);
    const width = 800;
    for (let i = 0; i < flight.points.length; i += 25) {
      const x = indexToX(flight.points, i, width, flight.durationMs);
      const back = xToIndex(flight.points, x, width, flight.durationMs);
      expect(Math.abs(back - i)).toBeLessThanOrEqual(1);
    }
  });

  it("downsampling keeps the max of a bucket so a spike survives", () => {
    // Craft a flight where many points map to the same pixel column and one
    // of them has a spike in speed. downsample must keep that spike as the
    // bucket's max.
    const points = Array.from({ length: 50 }, (_, i) => ({
      i,
      t: i * 1, // very small delta so many points share a column
      lat: 0,
      lng: 0,
      speedMps: i === 25 ? 100 : 10, // one spike at i=25
      altitudeM: 0,
    }));
    const buckets = downsample(points, 5, 49);
    // The spike lands in some bucket; find it and check the max.
    const spikeMph = 100 * MPS_TO_MPH;
    const maxes = buckets.map((b) => b.speedMaxMph ?? 0);
    expect(Math.max(...maxes)).toBeCloseTo(spikeMph, 2);
    // And its bucket also contains the min from a non-spike neighbour.
    const spikeBucket = buckets.find(
      (b) => (b.speedMaxMph ?? 0) >= spikeMph - 0.01,
    )!;
    expect(spikeBucket.speedMinMph).toBeCloseTo(10 * MPS_TO_MPH, 2);
  });
});

describe("Timeline (component)", () => {
  beforeEach(() => {
    // Fake timers so the throttle window is under the test's control.
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows 'no flight loaded' when there is no flight", () => {
    render(
      <Timeline flight={null} loadingError={null} playheadIndex={null} onSeek={() => {}} />,
    );
    expect(screen.getByTestId("timeline-empty")).toHaveTextContent(
      "no flight loaded",
    );
  });

  it("hover fills the readout row", () => {
    const flight = makeFlight(50);
    render(
      <Timeline flight={flight} loadingError={null} playheadIndex={null} onSeek={() => {}} width={800} height={200} />,
    );
    const svg = screen.getByTestId("timeline-svg");
    // Stub getBoundingClientRect so pointer coordinates map deterministically.
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 200, width: 800, height: 200,
      toJSON() { return {}; },
    } as DOMRect);
    // Move the pointer roughly to the middle of the plot area.
    fireEvent.pointerMove(svg, { clientX: 400, clientY: 100, pointerId: 1 });
    expect(screen.getByTestId("readout-time").textContent).not.toBe("");
    expect(screen.getByTestId("readout-mph").textContent).toMatch(/mph/);
    expect(screen.getByTestId("readout-ft").textContent).toMatch(/ft/);
    expect(screen.getByTestId("readout-index").textContent).toMatch(
      /point \d+ of 50/,
    );
  });

  it("a drag of three pointer moves within 200 ms sends one trailing PATCH plus one on release", () => {
    const flight = makeFlight(100);
    const onSeek = vi.fn();
    render(
      <Timeline
        flight={flight}
        loadingError={null}
        playheadIndex={0}
        onSeek={onSeek}
        width={800}
        height={200}
      />,
    );
    const svg = screen.getByTestId("timeline-svg");
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 200, width: 800, height: 200,
      toJSON() { return {}; },
    } as DOMRect);
    fireEvent.pointerDown(svg, { clientX: 200, clientY: 100, pointerId: 1 });
    // Three moves inside one 200 ms window, the trailing throttle folds them
    // into one PATCH at the end of the window.
    fireEvent.pointerMove(svg, { clientX: 210, clientY: 100, pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(30);
    });
    fireEvent.pointerMove(svg, { clientX: 220, clientY: 100, pointerId: 1 });
    act(() => {
      vi.advanceTimersByTime(30);
    });
    fireEvent.pointerMove(svg, { clientX: 230, clientY: 100, pointerId: 1 });
    // No seek yet, we are inside the trailing window.
    expect(onSeek).not.toHaveBeenCalled();
    // Let the trailing timer fire (200 ms since it was armed at the first move).
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onSeek).toHaveBeenCalledTimes(1);
    const trailingIndex = onSeek.mock.calls[0]![0];
    expect(trailingIndex).toBeGreaterThan(0);
    // Now release: one more PATCH with the released index. The released x is
    // 230 (same as the last move) so this may equal the trailing seek, but
    // the docs still call for one PATCH on release.
    fireEvent.pointerUp(svg, { clientX: 240, clientY: 100, pointerId: 1 });
    expect(onSeek).toHaveBeenCalledTimes(2);
    const releaseIndex = onSeek.mock.calls[1]![0];
    expect(releaseIndex).toBeGreaterThan(0);
    // No further seeks after we advance past another window.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onSeek).toHaveBeenCalledTimes(2);
  });

  it("ArrowRight sends index + 1 and Shift+ArrowRight sends index + 10", () => {
    const flight = makeFlight(100);
    const onSeek = vi.fn();
    render(
      <Timeline
        flight={flight}
        loadingError={null}
        playheadIndex={30}
        onSeek={onSeek}
        width={800}
      />,
    );
    const svg = screen.getByTestId("timeline-svg");
    (svg as unknown as HTMLElement).focus();
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    expect(onSeek).toHaveBeenLastCalledWith(31);
    fireEvent.keyDown(svg, { key: "ArrowRight", shiftKey: true });
    expect(onSeek).toHaveBeenLastCalledWith(40);
    fireEvent.keyDown(svg, { key: "ArrowLeft" });
    expect(onSeek).toHaveBeenLastCalledWith(29);
    fireEvent.keyDown(svg, { key: "Home" });
    expect(onSeek).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(svg, { key: "End" });
    expect(onSeek).toHaveBeenLastCalledWith(99);
  });

  it("draws a playhead at the run's current index", () => {
    const flight = makeFlight(100);
    render(
      <Timeline
        flight={flight}
        loadingError={null}
        playheadIndex={50}
        onSeek={() => {}}
        width={800}
      />,
    );
    expect(screen.getByTestId("timeline-playhead")).toBeInTheDocument();
    const svg = screen.getByTestId("timeline-svg");
    expect(svg.getAttribute("aria-valuenow")).toBe("50");
    expect(svg.getAttribute("aria-valuemax")).toBe("99");
    expect(svg.getAttribute("role")).toBe("slider");
  });

  it("hides the playhead when playheadIndex is null", () => {
    const flight = makeFlight(100);
    render(
      <Timeline
        flight={flight}
        loadingError={null}
        playheadIndex={null}
        onSeek={() => {}}
        width={800}
      />,
    );
    expect(screen.queryByTestId("timeline-playhead")).toBeNull();
  });

  it("renders the 'no altitude in this recording' legend when hasAltitude is false", () => {
    const flight = makeFlight(20);
    const noAlt: FlightSeries = {
      ...flight,
      hasAltitude: false,
      points: flight.points.map((p) => ({ ...p, altitudeM: null })),
    };
    render(
      <Timeline flight={noAlt} loadingError={null} playheadIndex={null} onSeek={() => {}} width={800} />,
    );
    expect(screen.getByTestId("timeline-alt-legend")).toHaveTextContent(
      "no altitude in this recording",
    );
  });

  it("labels the speed legend 'mph (derived)' when speedSource is derived", () => {
    const flight = { ...makeFlight(20), speedSource: "derived" as const };
    render(
      <Timeline flight={flight} loadingError={null} playheadIndex={null} onSeek={() => {}} width={800} />,
    );
    expect(screen.getByTestId("timeline-speed-legend")).toHaveTextContent(
      "mph (derived)",
    );
  });
});
