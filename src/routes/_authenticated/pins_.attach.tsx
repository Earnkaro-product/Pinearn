import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronDown,
  Check,
  Link2,
  Plus,
  Search,
  Sparkles,
  MousePointerClick,
  X,
} from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { supabase } from "@/integrations/supabase/client";
import {
  GRADIENTS,
  RATIOS,
  PinDetailDialog,
  type Pin,
  type Collection,
  type Product,
} from "./pins";

type AttachSearch = { collection?: string; pinId?: string; intent?: "monetize" };

export const Route = createFileRoute("/_authenticated/pins_/attach")({
  component: AttachPage,
  validateSearch: (search: Record<string, unknown>): AttachSearch => ({
    collection: typeof search.collection === "string" ? search.collection : undefined,
    pinId: typeof search.pinId === "string" ? search.pinId : undefined,
    intent: search.intent === "monetize" ? "monetize" : undefined,
  }),
});

type Tab = "pins" | "boards";
type SortBy = "" | "newest" | "impressions" | "clicks" | "ctr" | "earnings";

const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "impressions", label: "Impressions" },
  { value: "clicks", label: "Clicks" },
  { value: "ctr", label: "CTR" },
  { value: "earnings", label: "Earnings" },
];

function sortPins(pins: Pin[], sortBy: SortBy): Pin[] {
  return [...pins].sort((a, b) => {
    switch (sortBy) {
      case "impressions":
        return b.impressions - a.impressions;
      case "clicks":
        return b.clicks - a.clicks;
      case "earnings":
        return b.earnings_cents - a.earnings_cents;
      case "ctr": {
        const ctrA = a.impressions > 0 ? a.clicks / a.impressions : 0;
        const ctrB = b.impressions > 0 ? b.clicks / b.impressions : 0;
        return ctrB - ctrA;
      }
      case "newest":
      case "":
      default:
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    }
  });
}

function AttachPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  // Deep-linked from elsewhere (e.g. the dashboard's "Monetise" button on a
  // specific pin) — jump straight to that pin's attach dialog, skipping the
  // pick-a-pin grid.
  const [dialogPinId, setDialogPinId] = useState<string | null>(search.pinId ?? null);
  const [tab, setTab] = useState<Tab>(
    search.collection || search.intent === "monetize" ? "boards" : "pins",
  );
  const [activeBoardId, setActiveBoardId] = useState<string | null>(search.collection ?? null);
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("");
  // Whether we've asked "select a pin" vs "monetise the whole board" yet for
  // the currently active board. Deep-linked boards (?collection=) skip the
  // chooser and go straight to the pin grid, matching prior deep-link behavior.
  const [boardChoice, setBoardChoice] = useState<"ask" | "select-pin">(
    search.collection ? "select-pin" : "ask",
  );

  const { data: pins = [], isLoading } = useQuery({
    queryKey: ["pins"],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return [];
      const { data, error } = await supabase
        .from("pins")
        .select("*")
        .eq("user_id", userId)
        .eq("is_owner", true)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Pin[];
    },
  });

  const { data: collections = [] } = useQuery({
    queryKey: ["collections"],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return [];
      const { data } = await supabase
        .from("collections")
        .select("id,name,slug")
        .eq("user_id", userId)
        .order("position", { ascending: true });
      return (data ?? []) as Collection[];
    },
  });

  const { data: products = [] } = useQuery({
    queryKey: ["all-products"],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return [];
      const { data } = await supabase
        .from("storefront_products")
        .select(
          "id,title,affiliate_url,image_url,price_cents,currency,commission_pct,storefront_id,collection_id",
        )
        .eq("user_id", userId);
      return (data ?? []) as Product[];
    },
  });

  const boards = useMemo(() => {
    const byId = new Map<string, { collection: Collection; pins: Pin[] }>();
    for (const c of collections) byId.set(c.id, { collection: c, pins: [] });
    const unassigned: Pin[] = [];
    for (const p of pins) {
      // Already attached to a product (or published live) — nothing left to pick here.
      if (p.product_id || p.status === "live") continue;
      if (p.collection_id && byId.has(p.collection_id)) {
        byId.get(p.collection_id)!.pins.push(p);
      } else {
        unassigned.push(p);
      }
    }
    // Boards with nothing left to pick (no pins, or every pin already
    // handled above) are dead ends here — don't list them.
    const list = Array.from(byId.values()).filter((b) => b.pins.length > 0);
    if (unassigned.length > 0) {
      list.push({
        collection: { id: "__unassigned__", name: "Unassigned", slug: "unassigned" },
        pins: unassigned,
      });
    }
    return list;
  }, [pins, collections]);

  const activeBoard = boards.find((b) => b.collection.id === activeBoardId) ?? null;
  const dialogPin = pins.find((p) => p.id === dialogPinId) ?? null;
  // "Unassigned" is a synthetic bucket (pins with no collection_id), not a
  // real collection row — exclude it when picking a board to bulk-monetize.
  const selectableBoards =
    search.intent === "monetize"
      ? boards.filter((b) => b.collection.id !== "__unassigned__")
      : boards;

  const visiblePins = useMemo(() => {
    const base = activeBoard ? activeBoard.pins : pins;
    const q = query.trim().toLowerCase();
    const matched = q ? base.filter((p) => p.title?.toLowerCase().includes(q)) : base;
    return sortPins(matched, sortBy);
  }, [activeBoard, pins, query, sortBy]);

  const togglePin = (id: string) => {
    setSelectedPinId((cur) => (cur === id ? null : id));
  };

  const openAttachDialog = () => {
    if (selectedPinId) setDialogPinId(selectedPinId);
  };

  const openBoard = (id: string) => {
    if (search.intent === "monetize") {
      navigate({ to: "/pins/monetize-board", search: { collectionId: id, resume: undefined } });
      return;
    }
    setActiveBoardId(id);
    setBoardChoice("ask");
  };

  return (
    <AppShell
      title="Select pin"
      subtitle="Pick a pin to attach products to."
      backButton
      backTo="/pins"
      hideBottomNav
    >
      {dialogPin && (
        <PinDetailDialog
          pin={dialogPin}
          products={products}
          collections={collections}
          onClose={() => setDialogPinId(null)}
        />
      )}

      {/* Pinterest-style tabs */}
      {!activeBoard && (
        <div className="mb-6 flex items-center justify-center gap-8 border-b border-border/60">
          <TabButton active={tab === "pins"} onClick={() => setTab("pins")}>
            Pins
          </TabButton>
          <TabButton active={tab === "boards"} onClick={() => setTab("boards")}>
            Boards
          </TabButton>
        </div>
      )}

      {isLoading ? (
        <div className="masonry-3 sm:masonry-4 lg:masonry-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className={`${RATIOS[i % RATIOS.length]} animate-pulse rounded-2xl border border-border bg-surface/60`}
            />
          ))}
        </div>
      ) : activeBoard ? (
        <div className="space-y-5">
          <button
            onClick={() => setActiveBoardId(null)}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" /> All boards
          </button>
          <div>
            <h2 className="text-2xl font-bold">{activeBoard.collection.name}</h2>
            <p className="text-sm text-muted-foreground">
              {activeBoard.pins.length} {activeBoard.pins.length === 1 ? "Pin" : "Pins"}
            </p>
          </div>
          {boardChoice === "ask" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                onClick={() => setBoardChoice("select-pin")}
                className="flex flex-col items-start gap-2 rounded-2xl border border-border bg-surface p-5 text-left transition hover:shadow-elevate active:scale-[0.98]"
              >
                <span className="grid h-10 w-10 place-items-center rounded-full bg-primary/10 text-primary">
                  <MousePointerClick className="h-5 w-5" />
                </span>
                <span className="text-sm font-semibold">Select pin from board</span>
                <span className="text-xs text-muted-foreground">
                  Pick one pin and attach products to it.
                </span>
              </button>
              {activeBoard.collection.id !== "__unassigned__" && (
                <button
                  onClick={() =>
                    navigate({
                      to: "/pins/monetize-board",
                      search: { collectionId: activeBoard.collection.id, resume: undefined },
                    })
                  }
                  className="flex flex-col items-start gap-2 rounded-2xl border border-border bg-surface p-5 text-left transition hover:shadow-elevate active:scale-[0.98]"
                >
                  <span className="grid h-10 w-10 place-items-center rounded-full bg-gradient-primary text-primary-foreground shadow-glow">
                    <Sparkles className="h-5 w-5" />
                  </span>
                  <span className="text-sm font-semibold">Monetise full board</span>
                  <span className="text-xs text-muted-foreground">
                    Swipe through AI-recommended products for every unmonetised pin.
                  </span>
                </button>
              )}
            </div>
          ) : activeBoard.pins.length === 0 ? (
            <EmptyBlock
              text="No pins in this board."
              actionLabel="Create pin"
              onAction={() => navigate({ to: "/pins/create" })}
            />
          ) : (
            <>
              <SearchSortBar
                query={query}
                onQuery={setQuery}
                sortBy={sortBy}
                onSortBy={setSortBy}
              />
              {visiblePins.length === 0 ? (
                <EmptyBlock
                  text={`No pins match "${query}".`}
                  actionLabel="Clear search"
                  onAction={() => setQuery("")}
                />
              ) : (
                <PinGrid pins={visiblePins} selectedId={selectedPinId} onToggle={togglePin} />
              )}
            </>
          )}
        </div>
      ) : tab === "pins" ? (
        pins.length === 0 ? (
          <EmptyBlock
            text="No pins yet."
            actionLabel="Create pin"
            onAction={() => navigate({ to: "/pins/create" })}
          />
        ) : (
          <div className="space-y-4">
            <SearchSortBar query={query} onQuery={setQuery} sortBy={sortBy} onSortBy={setSortBy} />
            {visiblePins.length === 0 ? (
              <EmptyBlock
                text={`No pins match "${query}".`}
                actionLabel="Clear search"
                onAction={() => setQuery("")}
              />
            ) : (
              <PinGrid pins={visiblePins} selectedId={selectedPinId} onToggle={togglePin} />
            )}
          </div>
        )
      ) : selectableBoards.length === 0 ? (
        <EmptyBlock text="No boards yet." />
      ) : (
        <BoardsGrid boards={selectableBoards} onSelect={openBoard} />
      )}

      {/* Sticky CTA once a pin is selected */}
      {selectedPinId && (
        <div
          className="fixed inset-x-0 bottom-0 z-40 border-t border-border/60 bg-surface/95 px-5 py-3 backdrop-blur-xl"
          style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
        >
          <div className="mx-auto flex max-w-2xl items-center gap-3">
            <button
              onClick={openAttachDialog}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-gradient-primary px-4 py-3 text-sm font-semibold text-primary-foreground shadow-glow transition active:scale-[0.98]"
            >
              <Link2 className="h-4 w-4" /> Attach products
            </button>
          </div>
        </div>
      )}
    </AppShell>
  );
}

function SearchSortBar({
  query,
  onQuery,
  sortBy,
  onSortBy,
}: {
  query: string;
  onQuery: (v: string) => void;
  sortBy: SortBy;
  onSortBy: (v: SortBy) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="group flex flex-1 items-center gap-2.5 rounded-full bg-surface-2 px-4 py-3 transition focus-within:bg-surface focus-within:ring-2 focus-within:ring-foreground">
        <Search className="h-[18px] w-[18px] shrink-0 text-foreground/60" strokeWidth={2.4} />
        <input
          type="text"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search pins by title…"
          className="w-full bg-transparent text-sm font-medium outline-none placeholder:text-foreground/45"
        />
        {query && (
          <button
            onClick={() => onQuery("")}
            aria-label="Clear search"
            className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-foreground/10 text-foreground/70 transition hover:bg-foreground/20"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      <SortDropdown value={sortBy} onChange={onSortBy} />
    </div>
  );
}

function SortDropdown({ value, onChange }: { value: SortBy; onChange: (v: SortBy) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    if (open) {
      document.addEventListener("mousedown", onDoc);
      return () => document.removeEventListener("mousedown", onDoc);
    }
  }, [open]);

  const activeLabel = SORT_OPTIONS.find((o) => o.value === value)?.label ?? "Sort by";

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex h-[46px] items-center gap-1.5 whitespace-nowrap rounded-full px-4 text-sm font-semibold transition ${
          value
            ? "bg-foreground text-background"
            : "bg-surface-2 text-foreground hover:bg-surface-2/70"
        }`}
      >
        {activeLabel}
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute right-0 top-[calc(100%+8px)] z-20 w-48 overflow-hidden rounded-2xl border border-border bg-surface p-1.5 shadow-elevate">
          {SORT_OPTIONS.map((o) => {
            const isActive = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm font-medium transition hover:bg-surface-2 ${
                  isActive ? "text-primary" : "text-foreground"
                }`}
              >
                {o.label}
                {isActive && <Check className="h-4 w-4" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative -mb-px px-1 pb-3 pt-1 text-lead font-semibold transition ${
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
      {active && (
        <span className="absolute inset-x-0 bottom-0 h-[3px] rounded-full bg-foreground" />
      )}
    </button>
  );
}

function EmptyBlock({
  text,
  actionLabel,
  onAction,
}: {
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-surface/40 p-12 text-center text-sm text-muted-foreground">
      <p>{text}</p>
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-glow"
        >
          <Plus className="h-3.5 w-3.5" /> {actionLabel}
        </button>
      )}
    </div>
  );
}

function BoardsGrid({
  boards,
  onSelect,
}: {
  boards: { collection: Collection; pins: Pin[] }[];
  onSelect: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {boards.map(({ collection, pins }, i) => {
        const [cover, ...rest] = pins;
        const side = rest.slice(0, 2);
        const grad = GRADIENTS[i % GRADIENTS.length];
        return (
          <button
            key={collection.id}
            onClick={() => onSelect(collection.id)}
            className="group text-left"
          >
            <div className="overflow-hidden rounded-2xl bg-surface ring-1 ring-border/60 transition group-hover:shadow-elevate">
              <div className="flex aspect-[4/3] gap-0.5">
                <div className={`relative flex-[2] bg-gradient-to-br ${grad}`}>
                  {cover?.image_url && (
                    <img
                      src={cover.image_url}
                      alt=""
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  )}
                </div>
                <div className="flex flex-1 flex-col gap-0.5">
                  {[0, 1].map((idx) => {
                    const p = side[idx];
                    const g = GRADIENTS[(i + idx + 1) % GRADIENTS.length];
                    return (
                      <div key={idx} className={`relative flex-1 bg-gradient-to-br ${g}`}>
                        {p?.image_url && (
                          <img
                            src={p.image_url}
                            alt=""
                            className="h-full w-full object-cover"
                            loading="lazy"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="px-1 pt-2">
              <h3 className="line-clamp-1 text-sm font-semibold">{collection.name}</h3>
              <p className="text-xs text-muted-foreground">
                {pins.length} {pins.length === 1 ? "Pin" : "Pins"}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// Responsive column count for the masonry — 3 on mobile, 4 from `sm` up.
// Matches the old CSS `masonry-3 sm:masonry-4` breakpoints.
function useMasonryColumns() {
  const [cols, setCols] = useState(3);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    const update = () => setCols(mq.matches ? 4 : 3);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return cols;
}

function PinGrid({
  pins,
  selectedId,
  onToggle,
}: {
  pins: Pin[];
  selectedId: string | null;
  onToggle: (id: string) => void;
}) {
  const cols = useMasonryColumns();
  // Distribute round-robin across columns so recency reads left-to-right,
  // top-to-bottom (item 0,1,2 fill the top row) — CSS `column-count` instead
  // stacks the newest pins down the first column, hiding the sort order.
  const columns: { pin: Pin; idx: number }[][] = Array.from({ length: cols }, () => []);
  pins.forEach((pin, idx) => columns[idx % cols].push({ pin, idx }));

  return (
    <div className="flex gap-4">
      {columns.map((column, ci) => (
        <div key={ci} className="flex flex-1 flex-col gap-4">
          {column.map(({ pin: p, idx }) => {
            const grad = GRADIENTS[idx % GRADIENTS.length];
            const selected = selectedId === p.id;
            return (
              <article
                key={p.id}
                onClick={() => onToggle(p.id)}
                className={`group relative cursor-pointer overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 transition active:scale-[0.98] hover:shadow-elevate ${
                  selected ? "ring-2 ring-primary" : "ring-border/60"
                }`}
              >
                {/* No forced aspect ratio — each pin renders at its own image's
                    real proportions, like native Pinterest masonry. */}
                <div
                  className={`relative w-full bg-gradient-to-br ${grad} ${p.image_url ? "" : "aspect-square"}`}
                >
                  {p.image_url && (
                    <img src={p.image_url} alt="" className="block h-auto w-full" loading="lazy" />
                  )}
                  {selected && (
                    <div className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-primary text-primary-foreground shadow-glow">
                      <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                        <path
                          fillRule="evenodd"
                          d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 111.4-1.4L8 12.6l7.3-7.3a1 1 0 011.4 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </div>
                  )}
                  <h3 className="sr-only">{p.title}</h3>
                </div>
              </article>
            );
          })}
        </div>
      ))}
    </div>
  );
}
