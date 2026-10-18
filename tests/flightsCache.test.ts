// Flights cache (simulator-beacon.md 4). The listing comes from the cache
// and is refreshed on the call when older than a minute; a year with no
// published locations is omitted; `pointCount` is the true count.

import { describe, expect, it } from "vitest";
import type { EventItem, FlightsApi, LocationRow } from "../src/flights/api.js";
import { createFlightsCache } from "../src/flights/cache.js";

function makePoints(n: number, startSeq = 1): LocationRow[] {
  const out: LocationRow[] = [];
  const base = Date.parse("2025-12-22T01:00:00.000Z");
  for (let i = 0; i < n; i++) {
    out.push({
      seq: startSeq + i,
      recordedAt: new Date(base + i * 1000).toISOString(),
      lat: 46 + i * 0.0001,
      lng: -114 - i * 0.0001,
      speedMps: null,
      altitudeM: null,
      headingDeg: null,
      accuracyM: null,
    });
  }
  return out;
}

interface FakeApi extends FlightsApi {
  listEventsCalls: number;
  locationCallsByEvent: Map<number, number>;
}

function makeApi(
  events: EventItem[],
  locations: Map<number, LocationRow[]>,
): FakeApi {
  let listEventsCalls = 0;
  const locationCallsByEvent = new Map<number, number>();
  const api: FlightsApi = {
    async listEvents() {
      listEventsCalls += 1;
      return events.slice();
    },
    async listPublishedLocations(eventId: number) {
      locationCallsByEvent.set(
        eventId,
        (locationCallsByEvent.get(eventId) ?? 0) + 1,
      );
      return (locations.get(eventId) ?? []).slice();
    },
  };
  return Object.defineProperties(api as FakeApi, {
    listEventsCalls: { get: () => listEventsCalls, enumerable: true },
    locationCallsByEvent: {
      get: () => locationCallsByEvent,
      enumerable: true,
    },
  });
}

describe("flights cache (simulator-beacon.md 4)", () => {
  it("listYears against a fake API with two events, one without locations", async () => {
    const events: EventItem[] = [
      {
        id: 1,
        year: 2024,
        name: "Santa Flyover 2024",
        statusId: 4,
        scheduledAt: null,
        wentLiveAt: null,
        endedAt: null,
      },
      {
        id: 2,
        year: 2025,
        name: "Santa Flyover 2025",
        statusId: 4,
        scheduledAt: null,
        wentLiveAt: null,
        endedAt: null,
      },
    ];
    const locations = new Map<number, LocationRow[]>([
      [1, makePoints(5)],
      [2, []],
    ]);
    const api = makeApi(events, locations);
    const cache = createFlightsCache({ api });

    const items = await cache.listYears();
    expect(items).toEqual([
      { year: 2024, eventId: 1, name: "Santa Flyover 2024", pointCount: 5 },
    ]);
    // The event without published locations is dropped from the listing.
    expect(items.find((i) => i.year === 2025)).toBeUndefined();
  });

  it("populates pointCount from the API on the first listing call", async () => {
    const events: EventItem[] = [
      {
        id: 6,
        year: 2025,
        name: "Santa Flyover 2025",
        statusId: 4,
        scheduledAt: null,
        wentLiveAt: null,
        endedAt: null,
      },
    ];
    const locations = new Map<number, LocationRow[]>([[6, makePoints(1065)]]);
    const api = makeApi(events, locations);
    const cache = createFlightsCache({ api });

    const items = await cache.listYears();
    expect(items).toHaveLength(1);
    expect(items[0]!.pointCount).toBe(1065);
  });

  it("refresh loads every year's locations", async () => {
    const events: EventItem[] = [
      {
        id: 1,
        year: 2024,
        name: "2024",
        statusId: 4,
        scheduledAt: null,
        wentLiveAt: null,
        endedAt: null,
      },
      {
        id: 2,
        year: 2025,
        name: "2025",
        statusId: 4,
        scheduledAt: null,
        wentLiveAt: null,
        endedAt: null,
      },
    ];
    const locations = new Map<number, LocationRow[]>([
      [1, makePoints(3)],
      [2, makePoints(7)],
    ]);
    const api = makeApi(events, locations);
    const cache = createFlightsCache({ api });

    await cache.refresh();
    expect(api.locationCallsByEvent.get(1)).toBe(1);
    expect(api.locationCallsByEvent.get(2)).toBe(1);

    const items = await cache.listYears();
    expect(items.map((i) => i.year)).toEqual([2025, 2024]);
    expect(items.find((i) => i.year === 2024)!.pointCount).toBe(3);
    expect(items.find((i) => i.year === 2025)!.pointCount).toBe(7);
  });

  it("does not refresh on a listing call within the TTL window", async () => {
    let clock = 1_000_000;
    const events: EventItem[] = [
      {
        id: 1,
        year: 2025,
        name: "2025",
        statusId: 4,
        scheduledAt: null,
        wentLiveAt: null,
        endedAt: null,
      },
    ];
    const locations = new Map<number, LocationRow[]>([[1, makePoints(2)]]);
    const api = makeApi(events, locations);
    const cache = createFlightsCache({
      api,
      now: () => clock,
      refreshTtlMs: 60_000,
    });

    await cache.listYears();
    const eventCallsAfterFirst = api.listEventsCalls;
    // 30 s later: within the minute, no re-fetch.
    clock += 30_000;
    await cache.listYears();
    expect(api.listEventsCalls).toBe(eventCallsAfterFirst);
  });

  it("refreshes on a listing call once the TTL has passed", async () => {
    let clock = 1_000_000;
    const events: EventItem[] = [
      {
        id: 1,
        year: 2025,
        name: "2025",
        statusId: 4,
        scheduledAt: null,
        wentLiveAt: null,
        endedAt: null,
      },
    ];
    const locations = new Map<number, LocationRow[]>([[1, makePoints(2)]]);
    const api = makeApi(events, locations);
    const cache = createFlightsCache({
      api,
      now: () => clock,
      refreshTtlMs: 60_000,
    });

    await cache.listYears();
    const eventCallsAfterFirst = api.listEventsCalls;
    clock += 61_000;
    await cache.listYears();
    expect(api.listEventsCalls).toBeGreaterThan(eventCallsAfterFirst);
  });

  it("loadYear refreshes that year's points in the cache", async () => {
    const events: EventItem[] = [
      {
        id: 1,
        year: 2025,
        name: "2025",
        statusId: 4,
        scheduledAt: null,
        wentLiveAt: null,
        endedAt: null,
      },
    ];
    const locations = new Map<number, LocationRow[]>([[1, makePoints(4)]]);
    const api = makeApi(events, locations);
    const cache = createFlightsCache({ api });

    const first = await cache.loadYear(2025);
    expect(first.points.length).toBe(4);

    // A later start pulls the recording again (a live event's recording grows
    // until the event ends).
    locations.set(1, makePoints(9));
    const second = await cache.loadYear(2025);
    expect(second.points.length).toBe(9);
    expect(cache.cachedYears()).toEqual([2025]);
  });

  it("throws unknown_year when loadYear names a year with no event", async () => {
    const api = makeApi([], new Map());
    const cache = createFlightsCache({ api });
    await expect(cache.loadYear(2099)).rejects.toMatchObject({
      code: "unknown_year",
    });
  });

  it("a refresh drops a year whose event is gone from the listing", async () => {
    let clock = 0;
    const event = (id: number, year: number): EventItem => ({
      id,
      year,
      name: String(year),
      statusId: 4,
      scheduledAt: null,
      wentLiveAt: null,
      endedAt: null,
    });
    const events: EventItem[] = [event(1, 2024), event(2, 2025)];
    const locations = new Map<number, LocationRow[]>([
      [1, makePoints(3)],
      [2, makePoints(4)],
    ]);
    const api = makeApi(events, locations);
    const cache = createFlightsCache({ api, now: () => clock });

    expect((await cache.listYears()).map((y) => y.year)).toEqual([2025, 2024]);
    // The 2024 event is deleted; the next refresh (the listing is past its
    // 60 s age) no longer lists it and the cache no longer holds it.
    events.splice(0, 1);
    clock += 61_000;
    expect((await cache.listYears()).map((y) => y.year)).toEqual([2025]);
    expect(cache.cachedYears()).toEqual([2025]);
    expect(cache.getCached(2024)).toBeUndefined();
  });

  it("hasYear answers from the event listing and drops a vanished year", async () => {
    const events: EventItem[] = [
      {
        id: 1,
        year: 2025,
        name: "2025",
        statusId: 4,
        scheduledAt: null,
        wentLiveAt: null,
        endedAt: null,
      },
    ];
    const api = makeApi(events, new Map([[1, makePoints(2)]]));
    const cache = createFlightsCache({ api });
    await cache.loadYear(2025);
    expect(await cache.hasYear(2025)).toBe(true);
    expect(cache.cachedYears()).toEqual([2025]);
    events.splice(0, 1);
    expect(await cache.hasYear(2025)).toBe(false);
    expect(cache.cachedYears()).toEqual([]);
  });

  it("loadYear for a vanished year drops its cached flight", async () => {
    const events: EventItem[] = [
      {
        id: 1,
        year: 2025,
        name: "2025",
        statusId: 4,
        scheduledAt: null,
        wentLiveAt: null,
        endedAt: null,
      },
    ];
    const api = makeApi(events, new Map([[1, makePoints(2)]]));
    const cache = createFlightsCache({ api });
    await cache.loadYear(2025);
    events.splice(0, 1);
    await expect(cache.loadYear(2025)).rejects.toMatchObject({
      code: "unknown_year",
    });
    expect(cache.getCached(2025)).toBeUndefined();
  });
});
