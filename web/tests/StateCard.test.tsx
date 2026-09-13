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
      onYearChange={noop}
      onSpeedChange={noop}
      onStart={noop}
      onStop={noop}
      onRestart={noop}
      errorLine={null}
      busy=""
      speedOptions={SPEED_OPTIONS}
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
    // The elapsed field is a rendered duration, not empty (Date is stubbed by
    // jsdom's Date).
    expect(screen.getByTestId("run-elapsed").textContent).not.toBe("—");
    // lastError = null in the fixture, so the field renders the placeholder.
    expect(screen.getByTestId("run-error")).toHaveTextContent("—");
    // startedAt lands on the progress meta.
    expect(container.textContent ?? "").toContain(
      `started ${STATE_FIXTURE.run.startedAt}`,
    );
    // Progress bar: 412 / 1065 rounds to 39%.
    const fill = screen.getByTestId("progress-fill");
    expect(fill.getAttribute("style") ?? "").toContain("width: 39%");
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
});
