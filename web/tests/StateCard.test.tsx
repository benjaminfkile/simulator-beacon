import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StateCard } from "../src/StateCard.js";
import { STATE_FIXTURE } from "./state.fixture.js";
import type { Speed, YearItem } from "../src/types.js";

const SPEED_OPTIONS: readonly Speed[] = [1, 2, 5, 10, 20, 60] as const;

const YEARS: YearItem[] = [
  { year: 2025, eventId: 7, name: "WMSFO 2025", pointCount: 1065 },
  { year: 2024, eventId: 6, name: "WMSFO 2024", pointCount: 812 },
];

function renderCard(overrides: Partial<Parameters<typeof StateCard>[0]> = {}) {
  const noop = (): void => {};
  return render(
    <StateCard
      state={STATE_FIXTURE}
      years={YEARS}
      selectedYear={2025}
      selectedSpeed={20}
      selectedLoop
      onYearChange={noop}
      onSpeedChange={noop}
      onLoopChange={noop}
      onStart={noop}
      onStop={noop}
      onRestart={noop}
      onSeek={noop}
      errorLine={null}
      busy=""
      speedOptions={SPEED_OPTIONS}
      flight={null}
      flightError={null}
      {...overrides}
    />,
  );
}

describe("StateCard", () => {
  it("renders every field of the state fixture", () => {
    const { container } = renderCard();
    // Beacon block
    expect(screen.getByTestId("beacon-name")).toHaveTextContent(
      STATE_FIXTURE.beacon!.name!,
    );
    expect(screen.getByTestId("beacon-active")).toHaveTextContent("Active");
    expect(screen.getByTestId("beacon-live-event")).toHaveTextContent(
      String(STATE_FIXTURE.beacon!.liveEventId),
    );
    expect(screen.getByTestId("beacon-socket")).toHaveTextContent(
      STATE_FIXTURE.beacon!.socketState!,
    );
    expect(screen.getByTestId("beacon-last-delivered")).toHaveTextContent(
      String(STATE_FIXTURE.beacon!.lastDeliveredSeqLocal),
    );
    expect(screen.getByTestId("beacon-latency")).toHaveTextContent(
      `${STATE_FIXTURE.beacon!.lastReceiptLatencyMs} ms`,
    );
    expect(screen.getByTestId("beacon-heartbeat-age")).toHaveTextContent(
      `${STATE_FIXTURE.beacon!.heartbeatAge} s`,
    );
    // A revoked=false fixture does not raise the banner.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    // Run block
    expect(screen.getByTestId("run-status")).toHaveTextContent(
      STATE_FIXTURE.run.status,
    );
    expect(screen.getByTestId("run-year")).toHaveTextContent(
      String(STATE_FIXTURE.run.year),
    );
    expect(screen.getByTestId("run-speed")).toHaveTextContent(
      `${STATE_FIXTURE.run.speed}x`,
    );
    expect(screen.getByTestId("run-progress")).toHaveTextContent(
      `${STATE_FIXTURE.run.index} / ${STATE_FIXTURE.run.total}`,
    );
    // The elapsed field is a rendered duration, not the empty placeholder
    // (Date is stubbed by jsdom's Date).
    expect(screen.getByTestId("run-elapsed").textContent).not.toBe("none");
    // lastError = null in the fixture, so the field renders the placeholder.
    expect(screen.getByTestId("run-error")).toHaveTextContent("none");
    // The progress bar was removed with B11; the chart is the progress now
    // and the container carries no `progress-fill` mark.
    expect(container.querySelector('[data-testid="progress-fill"]')).toBeNull();
    // Next fix in ms is present when the fixture carries it.
    expect(screen.getByTestId("run-next-fix")).toHaveTextContent(
      `${STATE_FIXTURE.run.nextFixInMs} ms`,
    );
  });

  it("shows the revoked banner when the beacon key is revoked", () => {
    const revoked = {
      ...STATE_FIXTURE,
      beacon: { ...STATE_FIXTURE.beacon!, revoked: true },
    };
    renderCard({ state: revoked });
    expect(screen.getByRole("alert")).toHaveTextContent("Beacon key revoked");
  });

  it("shows the 409 already_running error line as given", () => {
    renderCard({ errorLine: "a run is already active" });
    expect(screen.getByTestId("error-line")).toHaveTextContent(
      "a run is already active",
    );
  });

  it("emits the selected year and speed to the callbacks", () => {
    const onYearChange = vi.fn();
    const onSpeedChange = vi.fn();
    renderCard({ onYearChange, onSpeedChange });
    fireEvent.change(screen.getByTestId("year-select"), {
      target: { value: "2024" },
    });
    fireEvent.change(screen.getByTestId("speed-select"), {
      target: { value: "60" },
    });
    expect(onYearChange).toHaveBeenCalledWith(2024);
    expect(onSpeedChange).toHaveBeenCalledWith(60);
  });

  it("says 'no leader' when the beacon block is absent", () => {
    renderCard({ state: { ...STATE_FIXTURE, beacon: null } });
    expect(screen.getByTestId("beacon-active")).toHaveTextContent("no leader");
  });

  it("disables Start when no year is selected", () => {
    renderCard({ selectedYear: "" });
    expect(screen.getByTestId("btn-start")).toBeDisabled();
  });

  it("shows the cycle n badge only when cycles > 0", () => {
    // The fixture has cycles = 0, so no cycle badge.
    const { queryByTestId, rerender } = renderCard();
    expect(queryByTestId("run-cycle")).toBeNull();
    // A run with cycles = 2 shows "cycle 2" next to the status pill.
    rerender(
      <StateCard
        state={{ ...STATE_FIXTURE, run: { ...STATE_FIXTURE.run, cycles: 2 } }}
        years={YEARS}
        selectedYear={2025}
        selectedSpeed={20}
        selectedLoop
        onYearChange={() => {}}
        onSpeedChange={() => {}}
        onLoopChange={() => {}}
        onStart={() => {}}
        onStop={() => {}}
        onRestart={() => {}}
        onSeek={() => {}}
        errorLine={null}
        busy=""
        speedOptions={SPEED_OPTIONS}
        flight={null}
        flightError={null}
      />,
    );
    expect(queryByTestId("run-cycle")).toHaveTextContent("cycle 2");
  });

  it("Start reads Resume when the run is stopped mid-recording for the selected year", () => {
    // Stopped, index in range, year matches → Resume; Stop reads Pause.
    renderCard({
      state: {
        ...STATE_FIXTURE,
        run: {
          ...STATE_FIXTURE.run,
          status: "stopped",
          year: 2025,
          index: 200,
          total: 1065,
        },
      },
      selectedYear: 2025,
    });
    expect(screen.getByTestId("btn-start")).toHaveTextContent("Resume");
    expect(screen.getByTestId("btn-stop")).toHaveTextContent("Pause");
  });

  it("Start reads Start when the run is running (not stopped)", () => {
    renderCard();
    expect(screen.getByTestId("btn-start")).toHaveTextContent("Start");
  });

  it("Start reads Start when index == total (a run that ended without loop)", () => {
    renderCard({
      state: {
        ...STATE_FIXTURE,
        run: {
          ...STATE_FIXTURE.run,
          status: "stopped",
          year: 2025,
          index: 1065,
          total: 1065,
        },
      },
      selectedYear: 2025,
    });
    expect(screen.getByTestId("btn-start")).toHaveTextContent("Start");
  });

  it("Start reads Start when the selected year differs from the row's year", () => {
    renderCard({
      state: {
        ...STATE_FIXTURE,
        run: {
          ...STATE_FIXTURE.run,
          status: "stopped",
          year: 2024,
          index: 200,
          total: 1065,
        },
      },
      selectedYear: 2025,
    });
    expect(screen.getByTestId("btn-start")).toHaveTextContent("Start");
  });
});
