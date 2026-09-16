import { describe, expect, test } from "bun:test";
import {
  EMPTY_ATTACHMENT,
  attachedLinkSet,
  composeAttachedTags,
  normalizeCollectionUrl,
  pinCollectionSlug,
  pinCollectionUrl,
  sequenceProductTags,
  tagFromUrl,
} from "./product-tag-data";
import type { PlannedTag, ProductTagPlan } from "./product-tags.functions";
import { MAX_PRODUCT_TAGS_PER_PIN, canonicalTagLink } from "./product-tagging";

function planned(rank: number, link: string, title = link): PlannedTag {
  return {
    rank,
    score: 1 - rank / 100,
    confidence: "high",
    source: "auto",
    category: "footwear",
    label: "Sneakers",
    componentKey: 0,
    box: null,
    match: { title, link, source: "Myntra", thumbnail: null, price: null },
    pinterestProductPinId: null,
    productId: null,
  };
}

function plan(tags: PlannedTag[], extraRanked: PlannedTag[] = []): ProductTagPlan {
  return {
    imageUrl: "https://img/x.jpg",
    limit: MAX_PRODUCT_TAGS_PER_PIN,
    noProducts: false,
    tags,
    ranked: [...tags, ...extraRanked],
  };
}

const A = planned(1, "https://a.in/1");
const B = planned(2, "https://a.in/2");
const C = planned(9, "https://a.in/9"); // ranked, but not in the plan's chosen set

describe("composeAttachedTags — the plan is the default, taps are deltas", () => {
  test("with no taps, the plan's tags are attached in rank order", () => {
    const out = composeAttachedTags(plan([B, A]), EMPTY_ATTACHMENT, []);
    expect(out.map((t) => t.link)).toEqual(["https://a.in/1", "https://a.in/2"]);
  });

  test("tapping a planned card off removes it; tapping an unplanned card on adds it at its rank", () => {
    const out = composeAttachedTags(
      plan([A, B], [C]),
      {
        ...EMPTY_ATTACHMENT,
        overrides: new Map([
          ["https://a.in/1", { selected: false, match: A.match }],
          ["https://a.in/9", { selected: true, match: C.match }],
        ]),
      },
      [],
    );
    expect(out.map((t) => t.link)).toEqual(["https://a.in/2", "https://a.in/9"]);
    expect(out[1].rank).toBe(9);
  });

  test("owned products and pasted links follow the ranked ones, in attachment order", () => {
    const out = composeAttachedTags(
      plan([A]),
      {
        ...EMPTY_ATTACHMENT,
        productIds: ["p1"],
        pasted: [tagFromUrl("https://shop.in/x", "X", null)],
      },
      [
        {
          id: "p1",
          title: "Owned",
          affiliate_url: "https://owned.in/1",
          image_url: null,
          price_cents: 100,
        },
      ],
    );
    expect(out.map((t) => t.link)).toEqual([
      "https://a.in/1",
      "https://owned.in/1",
      "https://shop.in/x",
    ]);
    expect(out[1].rank).toBeNull();
  });

  test("a card tapped on before the backend ranked it is attached unranked", () => {
    const out = composeAttachedTags(
      undefined,
      {
        ...EMPTY_ATTACHMENT,
        overrides: new Map([
          ["https://a.in/5", { selected: true, match: planned(5, "https://a.in/5").match }],
        ]),
      },
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0].rank).toBeNull();
    expect(attachedLinkSet(out).has("https://a.in/5")).toBe(true);
  });

  test("never more than the limit, duplicates collapse", () => {
    const many = Array.from({ length: MAX_PRODUCT_TAGS_PER_PIN + 4 }, (_, i) =>
      planned(i + 1, `https://a.in/${i + 1}`),
    );
    const out = composeAttachedTags(
      plan(many),
      {
        ...EMPTY_ATTACHMENT,
        pasted: [tagFromUrl("https://a.in/1?utm_source=x", "dup", null)],
      },
      [],
    );
    expect(out).toHaveLength(MAX_PRODUCT_TAGS_PER_PIN);
    expect(out.filter((t) => canonicalTagLink(t.link) === "https://a.in/1").length).toBe(1);
  });
});

describe("sequenceProductTags", () => {
  test("is stable for unranked items and puts ranked first", () => {
    const u1 = tagFromUrl("https://u.in/1", "u1", null);
    const u2 = tagFromUrl("https://u.in/2", "u2", null);
    const r = { ...tagFromUrl("https://r.in/1", "r", null), rank: 3 };
    expect(sequenceProductTags([u1, r, u2]).map((t) => t.title)).toEqual(["r", "u1", "u2"]);
  });
});

describe("pin collection URL", () => {
  test("slug is deterministic from title + pin id and URL uses the ?c= deep link", () => {
    const id = "0b7b6b0e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
    expect(pinCollectionSlug("  Panda  desk set!", id)).toBe("panda-desk-set-0b7b6b");
    expect(pinCollectionSlug("", id)).toBe("collection-0b7b6b");
    expect(pinCollectionUrl("https://app.test", "dua", "panda-desk-set-0b7b6b")).toBe(
      "https://app.test/s/dua?c=panda-desk-set-0b7b6b",
    );
  });
  test("legacy #slug destinations read as ?c=", () => {
    expect(normalizeCollectionUrl("https://app.test/s/dua#panda-ab12")).toBe(
      "https://app.test/s/dua?c=panda-ab12",
    );
    expect(normalizeCollectionUrl("https://app.test/s/dua?c=x")).toBe("https://app.test/s/dua?c=x");
  });
});
