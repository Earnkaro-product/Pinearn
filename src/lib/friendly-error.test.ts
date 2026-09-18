import { describe, expect, test } from "bun:test";
import { getFriendlyMessage } from "./friendly-error";

describe("getFriendlyMessage", () => {
  test("masks technical noise behind safe copy", () => {
    expect(getFriendlyMessage(new Error("duplicate key value violates unique constraint"))).toBe(
      "That already exists.",
    );
    expect(getFriendlyMessage(new Error("JWT expired"))).toBe(
      "Your session expired. Please sign in again.",
    );
    expect(getFriendlyMessage(new Error("Failed to fetch"))).toBe(
      "Network issue — check your connection and try again.",
    );
  });

  // The Go Live failures are written FOR the creator and say what to do next;
  // collapsing them into "Something went wrong" hid the only useful line.
  test("shows a server message that is already creator-facing", () => {
    for (const m of [
      "Attach at least one product before going live.",
      "Pin has no storefront",
      "This Pin was already published — refresh and try again.",
      "Pick a board that's synced from Pinterest first.",
    ]) {
      expect(getFriendlyMessage(new Error(m))).toBe(m);
    }
  });

  test("still hides genuinely technical text no pattern claims", () => {
    const generic = "Something went wrong. Please try again.";
    expect(getFriendlyMessage(new Error("Cannot read properties of undefined"))).toBe(generic);
    expect(getFriendlyMessage(new Error('{"code":"PGRST116","details":null}'))).toBe(generic);
    expect(getFriendlyMessage(new Error("TypeError: x is not a function"))).toBe(generic);
    expect(getFriendlyMessage(new Error("a".repeat(200)))).toBe(generic);
    expect(getFriendlyMessage(new Error("at handler (/app/server.js:1:1)"))).toBe(generic);
  });

  test("empty and non-error inputs fall back", () => {
    expect(getFriendlyMessage(new Error(""))).toBe("Something went wrong. Please try again.");
    expect(getFriendlyMessage(undefined)).toBe("Something went wrong. Please try again.");
  });
});
