import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ControlPanel } from "../src/App.js";
import { STATE_FIXTURE } from "./state.fixture.js";
import type { ApiClient } from "../src/api.js";

// The selects are seeded once and then belong to the operator: the one-second
// state poll must not put the row's year or speed back after a change.
function fakeApi(): ApiClient {
  const state = { ...STATE_FIXTURE, run: { ...STATE_FIXTURE.run, year: 2025, speed: 60 } };
  return {
    getState: vi.fn(async () => state),
    getYears: vi.fn(async () => ({
      items: [
        { year: 2025, eventId: 7, name: "WMSFO 2025", pointCount: 1065 },
        { year: 2024, eventId: 6, name: "WMSFO 2024", pointCount: 812 },
      ],
    })),
    start: vi.fn(async () => state),
    stop: vi.fn(async () => state),
    restart: vi.fn(async () => state),
  } as unknown as ApiClient;
}

describe("ControlPanel selects", () => {
  it("keeps the operator's year and speed across state polls", async () => {
    const api = fakeApi();
    render(<ControlPanel api={api} />);
    const year = (await screen.findByTestId("year-select")) as HTMLSelectElement;
    const speed = screen.getByTestId("speed-select") as HTMLSelectElement;
    await waitFor(() => expect(year.value).toBe("2025"));
    await waitFor(() => expect(speed.value).toBe("60"));
    fireEvent.change(year, { target: { value: "2024" } });
    fireEvent.change(speed, { target: { value: "5" } });
    expect(year.value).toBe("2024");
    // The panel polls the state every second; let two polls land.
    const calls = (api.getState as ReturnType<typeof vi.fn>).mock.calls.length;
    await waitFor(
      () => expect((api.getState as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(calls + 1),
      { timeout: 4000 },
    );
    expect(year.value).toBe("2024");
    expect(speed.value).toBe("5");
  }, 10_000);
});
