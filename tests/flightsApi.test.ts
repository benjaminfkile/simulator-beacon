// Flights API paging plus the 401 → failed path (simulator-beacon.md 4 and
// tests table).

import { describe, expect, it } from "vitest";
import { ApiError, createFlightsApi } from "../src/flights/api.js";

function scriptedFetch(script: Array<{ url: RegExp; status: number; body: unknown }>): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const impl = (async (input: unknown) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push(url);
    const step = script.find((s) => s.url.test(url));
    if (!step) throw new Error(`no scripted response for ${url}`);
    return new Response(JSON.stringify(step.body), {
      status: step.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

describe("flights api (simulator-beacon.md 4)", () => {
  it("lists events, mapping the row shape", async () => {
    const { fetch: f, calls } = scriptedFetch([
      {
        url: /\/admin\/events$/,
        status: 200,
        body: {
          items: [
            { id: 7, year: 2025, name: "Santa Flyover 2025", statusId: 4 },
            { id: 8, year: 2026, name: "Santa Flyover 2026", statusId: 3 },
          ],
        },
      },
    ]);
    const api = createFlightsApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: "wak_test",
      fetchImpl: f,
    });
    const events = await api.listEvents();
    expect(events.length).toBe(2);
    expect(events[0]!.id).toBe(7);
    expect(events[0]!.year).toBe(2025);
    expect(events[1]!.year).toBe(2026);
    expect(calls[0]).toBe("https://api.example.com/admin/events");
  });

  it("follows nextCursor across pages", async () => {
    const pointsA = Array.from({ length: 3 }, (_, i) => ({
      seq: i + 1,
      recordedAt: `2025-12-22T01:31:${(i + 1).toString().padStart(2, "0")}.000Z`,
      lat: 46 + i,
      lng: -114,
    }));
    const pointsB = Array.from({ length: 2 }, (_, i) => ({
      seq: i + 4,
      recordedAt: `2025-12-22T01:32:${(i + 1).toString().padStart(2, "0")}.000Z`,
      lat: 47 + i,
      lng: -113,
    }));
    const { fetch: f, calls } = scriptedFetch([
      {
        url: /\/admin\/events\/7\/locations\?publishedOnly=true&limit=\d+$/,
        status: 200,
        body: { items: pointsA, nextCursor: "cursor-2" },
      },
      {
        url: /cursor=cursor-2/,
        status: 200,
        body: { items: pointsB, nextCursor: null },
      },
    ]);
    const api = createFlightsApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: "wak_test",
      fetchImpl: f,
    });
    const rows = await api.listPublishedLocations(7);
    expect(rows.length).toBe(5);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(calls[0]).toMatch(/publishedOnly=true/);
    expect(calls[0]).toMatch(/limit=/);
    expect(calls[1]).toMatch(/cursor=cursor-2/);
  });

  it("throws ApiError with status 401 when the API refuses the key", async () => {
    const { fetch: f } = scriptedFetch([
      {
        url: /\/admin\/events\/7\/locations/,
        status: 401,
        body: { code: "unauthenticated", message: "revoked", requestId: "req-x" },
      },
    ]);
    const api = createFlightsApi({
      apiBaseUrl: "https://api.example.com",
      apiKey: "wak_bad",
      fetchImpl: f,
    });
    await expect(api.listPublishedLocations(7)).rejects.toBeInstanceOf(ApiError);
    try {
      await api.listPublishedLocations(7);
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.status).toBe(401);
      expect(e.code).toBe("unauthenticated");
    }
  });
});
