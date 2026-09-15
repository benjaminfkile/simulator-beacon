import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom 25 does not implement PointerEvent, so testing-library's fireEvent
// falls back to a plain Event that drops clientX. Polyfill it as a
// MouseEvent so the drag/hover tests can pass coordinates.
if (typeof (globalThis as unknown as { PointerEvent?: unknown }).PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    public readonly pointerId: number;
    public readonly pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  (globalThis as unknown as { PointerEvent: unknown }).PointerEvent =
    PointerEventPolyfill;
  (window as unknown as { PointerEvent: unknown }).PointerEvent =
    PointerEventPolyfill;
}

// Element.setPointerCapture / releasePointerCapture do not exist in jsdom.
// Stub them so the drag handlers can safely call through.
if (typeof (Element.prototype as unknown as { setPointerCapture?: unknown }).setPointerCapture !== "function") {
  (Element.prototype as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture =
    () => {};
}
if (typeof (Element.prototype as unknown as { releasePointerCapture?: unknown }).releasePointerCapture !== "function") {
  (Element.prototype as unknown as { releasePointerCapture: (id: number) => void }).releasePointerCapture =
    () => {};
}

afterEach(() => {
  cleanup();
});
