import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConfigurationNotice } from "../src/ConfigurationNotice.js";

describe("ConfigurationNotice", () => {
  it("lists every missing key so the operator can fix the deploy", () => {
    const missing = [
      "VITE_SIM_API_BASE_URL",
      "VITE_COGNITO_AUTHORITY",
      "VITE_COGNITO_DOMAIN",
      "VITE_COGNITO_CLIENT_ID",
    ];
    render(<ConfigurationNotice missing={missing} />);
    const list = screen.getByTestId("missing-list");
    for (const k of missing) {
      expect(list).toHaveTextContent(k);
    }
  });
});
