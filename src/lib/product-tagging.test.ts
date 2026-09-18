import { describe, expect, test } from "bun:test";
import {
  MAX_PRODUCT_TAGS_PER_PIN,
  canonicalTagLink,
  confidenceFor,
  identifierWords,
  scoreTagCandidate,
  selectProductTags,
  type TagCandidateInput,
  type TagComponentInput,
} from "./product-tagging";

// Deterministic fixtures — the shapes the pipeline emits, minus the network.

function cand(
  title: string,
  extra: Partial<TagCandidateInput> & { link?: string } = {},
): TagCandidateInput {
  return {
    title,
    link: extra.link ?? `https://www.myntra.com/${title.toLowerCase().replace(/\W+/g, "-")}`,
    source: extra.source ?? "Myntra",
    thumbnail: extra.thumbnail === undefined ? "https://img/x.jpg" : extra.thumbnail,
    price:
      extra.price === undefined
        ? { value: "₹999", extractedValue: 999, currency: "₹" }
        : extra.price,
    lookMatch: extra.lookMatch,
    score: extra.score,
  };
}

const sneakers: TagComponentInput = {
  key: 0,
  label: "White Sneakers",
  category: "footwear",
  signature: "white leather low-top sneaker",
};
const bag: TagComponentInput = {
  key: 1,
  label: "Handbag",
  category: "bag",
  signature: "tan leather",
};
const shades: TagComponentInput = { key: 2, label: "Sunglasses", category: "eyewear" };

describe("scoreTagCandidate — exactness", () => {
  test("the exact product beats the generic one for the same object", () => {
    const copy = "Nike Air Force 1 white sneakers outfit";
    const exact = scoreTagCandidate(
      cand("Nike Air Force 1 '07 White Sneakers", { lookMatch: "same" }),
      sneakers,
      1,
      copy,
    );
    const generic = scoreTagCandidate(
      cand("White Sneakers", { lookMatch: "same" }),
      sneakers,
      0,
      copy,
    );
    expect(exact.score).toBeGreaterThan(generic.score);
    expect(exact.confidence).toBe("high");
  });

  test("AirPods Pro 2nd Generation beats AirPods / AirPods Pro / generic earbuds", () => {
    const buds: TagComponentInput = { key: 0, label: "Earbuds", category: "electronics" };
    const copy = "Apple AirPods Pro 2 — my daily carry";
    const options = [
      cand("Apple AirPods (3rd Generation) Wireless Earbuds", { lookMatch: "close" }),
      cand("Apple AirPods Pro Wireless Earbuds", { lookMatch: "close" }),
      cand("Apple AirPods Pro 2nd Generation Earbuds with MagSafe", { lookMatch: "close" }),
      cand("Generic Wireless Earbuds TWS", { lookMatch: "close" }),
    ];
    const scored = options.map((c, i) => scoreTagCandidate(c, buds, i, copy));
    const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
    expect(best.candidate.title).toContain("2nd Generation");
  });

  test("a look-gate 'same' verdict alone is high; 'close' alone is only medium", () => {
    const same = scoreTagCandidate(cand("Women Sneakers", { lookMatch: "same" }), sneakers, 0, "");
    const close = scoreTagCandidate(
      cand("Women Sneakers", { lookMatch: "close" }),
      sneakers,
      0,
      "",
    );
    expect(same.confidence).toBe("high");
    expect(close.confidence).toBe("medium");
  });

  test("'close' becomes high when the Pin's copy and the look agree with the title", () => {
    const p = scoreTagCandidate(
      cand("Nike Air Force 1 White Leather Low-Top Sneakers", { lookMatch: "close" }),
      sneakers,
      0,
      "nike air force 1 fit",
    );
    expect(p.confidence).toBe("high");
  });

  test("a category conflict can never be auto-tagged", () => {
    const p = scoreTagCandidate(
      cand("Blue Denim Jeans", { lookMatch: "same" }),
      sneakers,
      0,
      "jeans",
    );
    expect(p.confidence).not.toBe("high");
    expect(p.signals.category).toBe(0);
  });

  test("a dead retailer page can never be auto-tagged", () => {
    const p = scoreTagCandidate(
      cand("White Sneakers", { lookMatch: "same" }),
      sneakers,
      0,
      "",
      null,
    );
    expect(p.confidence).not.toBe("high");
  });

  test("an unjudged fast-stage card is not high on rank alone", () => {
    const p = scoreTagCandidate(cand("White Sneakers"), sneakers, 0, "");
    expect(p.confidence).toBe("medium");
  });

  test("is deterministic", () => {
    const a = scoreTagCandidate(cand("Tan Leather Handbag", { lookMatch: "same" }), bag, 0, "bag");
    const b = scoreTagCandidate(cand("Tan Leather Handbag", { lookMatch: "same" }), bag, 0, "bag");
    expect(a).toEqual(b);
  });
});

describe("selectProductTags — one per object, limit, confidence bands", () => {
  test("picks the best per object and covers every category", () => {
    const out = selectProductTags({
      tabs: [
        {
          component: sneakers,
          candidates: [
            cand("White Sneakers Lookalike", { lookMatch: "close" }),
            cand("Nike Air Force 1 White Sneakers", { lookMatch: "same" }),
          ],
        },
        { component: bag, candidates: [cand("Tan Leather Handbag", { lookMatch: "same" })] },
        {
          component: shades,
          candidates: [cand("Ray-Ban Aviator Sunglasses", { lookMatch: "same" })],
        },
      ],
      pinCopy: "",
    });
    expect(out.auto.map((p) => p.component.label).sort()).toEqual([
      "Handbag",
      "Sunglasses",
      "White Sneakers",
    ]);
    expect(out.auto.find((p) => p.component.key === 0)?.candidate.title).toContain("Air Force");
    expect(out.suggested).toHaveLength(0);
    expect(out.unmatched).toHaveLength(0);
  });

  test("medium goes to suggested, low to neither, and unmatched names the object", () => {
    const out = selectProductTags({
      tabs: [
        { component: sneakers, candidates: [cand("White Sneakers", { lookMatch: "close" })] },
        { component: bag, candidates: [cand("Steel Water Bottle 1L")] },
      ],
      pinCopy: "",
    });
    expect(out.auto).toHaveLength(0);
    expect(out.suggested.map((p) => p.component.label)).toEqual(["White Sneakers"]);
    expect(out.unmatched.map((c) => c.label)).toEqual(["Handbag"]);
  });

  test("never exceeds the slot budget and never the Pinterest limit", () => {
    const tabs = Array.from({ length: MAX_PRODUCT_TAGS_PER_PIN + 5 }, (_, i) => ({
      component: { key: i, label: `Item ${i}`, category: "decor" as const },
      candidates: [
        cand(`Ceramic Vase ${i}`, { lookMatch: "same" as const, link: `https://a.in/${i}` }),
      ],
    }));
    const full = selectProductTags({ tabs, pinCopy: "" });
    expect(full.auto).toHaveLength(MAX_PRODUCT_TAGS_PER_PIN);
    expect(full.suggested).toHaveLength(5);
    const two = selectProductTags({ tabs, pinCopy: "", slots: 2 });
    expect(two.auto).toHaveLength(2);
    expect(two.suggested).toHaveLength(MAX_PRODUCT_TAGS_PER_PIN + 3);
    // The strongest objects win the slots, not the first ones.
    expect(two.auto.every((p) => p.score >= two.suggested[0].score)).toBe(true);
  });

  test("the same listing under two objects is one tag", () => {
    const shared = cand("Floral Midi Dress", { lookMatch: "same", link: "https://a.in/dress" });
    const out = selectProductTags({
      tabs: [
        { component: { key: 0, label: "Dress", category: "dress" }, candidates: [shared] },
        { component: { key: 1, label: "Top", category: "top" }, candidates: [shared] },
      ],
      pinCopy: "",
    });
    expect(out.auto).toHaveLength(1);
    expect(out.suggested).toHaveLength(0);
  });

  test("excluded links (already tagged / removed by the creator) are never re-proposed", () => {
    const out = selectProductTags({
      tabs: [
        {
          component: sneakers,
          candidates: [
            cand("Nike Air Force 1", { lookMatch: "same", link: "https://a.in/af1" }),
            cand("Puma Court Sneakers", { lookMatch: "close", link: "https://a.in/puma" }),
          ],
        },
      ],
      pinCopy: "",
      excludeLinks: new Set(["https://a.in/af1"]),
    });
    expect(out.auto).toHaveLength(0);
    expect(out.suggested[0]?.candidate.link).toBe("https://a.in/puma");
  });
});

describe("selectProductTags — the All sequence", () => {
  // The order the "All" tab renders in: each object's top three as a
  // contiguous BLOCK, in detection order, then the remainder interleaved tier
  // by tier. A flat score sort put one object's entire run of matches ahead of
  // the next object's, because candidates for one crop score within a whisker
  // of each other.

  // Four candidates per object, so the lead block (3) and the interleaved
  // tail (the 4th of each) are both exercised.
  const four = (prefix: string) => [
    cand(`${prefix} One`, { lookMatch: "same" }),
    cand(`${prefix} Two`, { lookMatch: "close" }),
    cand(`${prefix} Three`),
    cand(`${prefix} Four`, { price: null }),
  ];

  test("leads with each object's top three as a block, then interleaves the rest", () => {
    const { all } = selectProductTags({
      tabs: [
        { component: sneakers, candidates: four("White Sneakers") },
        { component: bag, candidates: four("Tan Leather Handbag") },
      ],
      pinCopy: "",
    });

    expect(all.map((p) => p.component.label)).toEqual([
      // Lead: sneakers' best three, then the bag's best three.
      "White Sneakers",
      "White Sneakers",
      "White Sneakers",
      "Handbag",
      "Handbag",
      "Handbag",
      // Tail: the 4th of each, interleaved.
      "White Sneakers",
      "Handbag",
    ]);
    // Within each object's lead block, best first.
    expect(all[0].score).toBeGreaterThanOrEqual(all[1].score);
    expect(all[1].score).toBeGreaterThanOrEqual(all[2].score);
    expect(all[3].score).toBeGreaterThanOrEqual(all[4].score);
  });

  test("an object with fewer than three candidates just contributes what it has", () => {
    const { all } = selectProductTags({
      tabs: [
        {
          component: sneakers,
          candidates: [cand("Nike Air Force 1 White Sneakers"), cand("White Sneakers Lookalike")],
        },
        { component: bag, candidates: [cand("Tan Leather Handbag")] },
      ],
      pinCopy: "",
    });
    expect(all.map((p) => p.component.label)).toEqual([
      "White Sneakers",
      "White Sneakers",
      "Handbag",
    ]);
  });

  test("every scored candidate still appears exactly once", () => {
    const { all } = selectProductTags({
      tabs: [
        { component: sneakers, candidates: four("White Sneakers") },
        { component: bag, candidates: four("Tan Leather Handbag") },
        { component: shades, candidates: four("Black Aviator Sunglasses") },
      ],
      pinCopy: "",
    });
    expect(all).toHaveLength(12);
    expect(new Set(all.map((p) => p.candidate.link)).size).toBe(12);
  });
});

describe("helpers", () => {
  test("confidence bands", () => {
    expect(confidenceFor(0.9)).toBe("high");
    expect(confidenceFor(0.5)).toBe("medium");
    expect(confidenceFor(0.1)).toBe("low");
  });
  test("identifier words pick model codes", () => {
    expect([...identifierWords("Apple AirPods Pro 2 and New Balance 990v6 AF1")]).toEqual(
      expect.arrayContaining(["990v6", "af1"]),
    );
  });
  test("canonical link strips tracking noise and case", () => {
    expect(canonicalTagLink("https://WWW.Myntra.com/x/1?utm_source=a&size=M#top")).toBe(
      "https://myntra.com/x/1?size=M",
    );
  });
});
