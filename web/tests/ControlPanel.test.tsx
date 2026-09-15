import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ControlPanel } from "../src/App.js";
import { STATE_FIXTURE } from "./state.fixture.js";
import type { ApiClient } from "../src/api.js";
import type { FlightSeries } from "../src/types.js";

function flightFor(year: number, pointCount = 4): FlightSeries {
  const points = Array.from({ length: pointCount }, (_, i) => ({
    i,
    t: i * 1000,
    lat: 40 + i * 0.001,
    lng: -74 + i * 0.001,
    speedMps: 10 + i,
    altitudeM: 100 + i,
  }));
  return {
    year,
    eventId: year - 2018,
    name: `WMSFO ${year}`,
    pointCount,
    firstRecordedAt: "2025-12-22T01:00:00.000Z",
    lastRecordedAt: "2025-12-22T01:00:03.000Z",
    durationMs: (pointCount - 1) * 1000,
    hasAltitude: true,
    speedSource: "recorded",
    points,
  };
}

// The selects and the loop switch are seeded once and then belong to the
// operator: the one-second state poll must not put the row's year, speed, or
// loop back after a change. A change while running also PATCHes the row per
// simulator-beacon.md 5.
function fakeApi(opts?: { flightFails?: boolean }): ApiClient {
  const state = {
    ...STATE_FIXTURE,
    run: { ...STATE_FIXTURE.run, year: 2025, speed: 60, loop: true, cycles: 0 },
  };
  return {
    getState: vi.fn(async () => state),
    getYears: vi.fn(async () => ({
      items: [
        { year: 2025, eventId: 7, name: "WMSFO 2025", pointCount: 1065 },
        { year: 2024, eventId: 6, name: "WMSFO 2024", pointCount: 812 },
      ],
    })),
    getFlight: vi.fn(async (year: number) => {
      if (opts?.flightFails) throw new Error("upstream_unavailable");
      return flightFor(year);
    }),
    start: vi.fn(async () => state),
    stop: vi.fn(async () => state),
    restart: vi.fn(async () => state),
    patchRun: vi.fn(async () => state),
  } as unknown as ApiClient;
}

describe("ControlPanel selects", () => {
  it("keeps the operator's year, speed, and loop across state polls", async () => {
    const api = fakeApi();
    render(<ControlPanel api={api} />);
    const year = (await screen.findByTestId("year-select")) as HTMLSelectElement;
    const speed = screen.getByTestId("speed-select") as HTMLSelectElement;
    const loop = screen.getByTestId("loop-switch") as HTMLInputElement;
    await waitFor(() => expect(year.value).toBe("2025"));
    await waitFor(() => expect(speed.value).toBe("60"));
    await waitFor(() => expect(loop.checked).toBe(true));
    fireEvent.change(year, { target: { value: "2024" } });
    fireEvent.change(speed, { target: { value: "5" } });
    fireEvent.click(loop);
    expect(year.value).toBe("2024");
    expect(loop.checked).toBe(false);
    // The panel polls the state every second; let two polls land.
    const calls = (api.getState as ReturnType<typeof vi.fn>).mock.calls.length;
    await waitFor(
      () => expect((api.getState as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(calls + 1),
      { timeout: 4000 },
    );
    expect(year.value).toBe("2024");
    expect(speed.value).toBe("5");
    expect(loop.checked).toBe(false);
  }, 10_000);

  it("sends PATCH /control/run on a mid-run speed change and on a loop toggle", async () => {
    const api = fakeApi();
    render(<ControlPanel api={api} />);
    const year = (await screen.findByTestId("year-select")) as HTMLSelectElement;
    const speed = screen.getByTestId("speed-select") as HTMLSelectElement;
    const loop = screen.getByTestId("loop-switch") as HTMLInputElement;
    await waitFor(() => expect(year.value).toBe("2025"));
    fireEvent.change(speed, { target: { value: "5" } });
    fireEvent.click(loop);
    await waitFor(() => {
      const patch = api.patchRun as ReturnType<typeof vi.fn>;
      expect(patch).toHaveBeenCalledWith({ speed: 5 });
      expect(patch).toHaveBeenCalledWith({ loop: false });
    });
  }, 10_000);

  it("fetches the flight on load and on a year change", async () => {
    const api = fakeApi();
    render(<ControlPanel api={api} />);
    const year = (await screen.findByTestId("year-select")) as HTMLSelectElement;
    await waitFor(() => expect(year.value).toBe("2025"));
    await waitFor(() => {
      expect(api.getFlight as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        2025,
      );
    });
    fireEvent.change(year, { target: { value: "2024" } });
    await waitFor(() => {
      expect(api.getFlight as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        2024,
      );
    });
  }, 10_000);

  it("shows 'no flight loaded' when the fetch fails", async () => {
    const api = fakeApi({ flightFails: true });
    render(<ControlPanel api={api} />);
    const year = (await screen.findByTestId("year-select")) as HTMLSelectElement;
    await waitFor(() => expect(year.value).toBe("2025"));
    await waitFor(() =>
      expect(api.getFlight as ReturnType<typeof vi.fn>).toHaveBeenCalled(),
    );
    // The empty-chart placeholder appears since no flight loaded.
    await waitFor(() =>
      expect(screen.getByTestId("timeline-empty")).toHaveTextContent(
        "no flight loaded",
      ),
    );
    // And the fetch error shows on the error line.
    await waitFor(() =>
      expect(screen.getByTestId("error-line")).toHaveTextContent(
        "upstream_unavailable",
      ),
    );
  }, 10_000);
});
