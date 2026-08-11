import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { Brand } from "@/lib/brands";
import { brandLogoUrl } from "@/lib/brands";
import { ArrowRight } from "lucide-react";

export function BrandLogo({ brand, size = 56 }: { brand: Brand; size?: number }) {
  const url = brandLogoUrl(brand);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  return (
    <div
      className="grid place-items-center overflow-hidden rounded-full bg-surface ring-1 ring-border/70"
      style={{ width: size, height: size }}
      aria-hidden
    >
      {url && !failed ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          onLoad={() => setLoaded(true)}
          className={`h-full w-full object-contain p-1.5 opacity-0 transition-opacity duration-300 ${loaded ? "opacity-100" : ""}`}
        />
      ) : (
        <span
          className="font-display font-bold leading-none"
          style={{ color: brand.color, fontSize: size * 0.36 }}
        >
          {brand.logoText ?? brand.name.slice(0, 1)}
        </span>
      )}
    </div>
  );
}

export function BrandCard({ brand }: { brand: Brand }) {
  return (
    <Link
      to="/brands/$brandId"
      params={{ brandId: brand.id }}
      className="group flex h-full w-full snap-start flex-col items-center justify-center gap-1.5 rounded-2xl border border-border bg-surface p-2.5 text-center transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-elevate"
    >
      <BrandLogo brand={brand} size={44} />
      <div className="mt-0.5 text-micro font-semibold text-primary">
        {brand.commission}% Earning
      </div>
    </Link>
  );
}

function ViewAllCard() {
  return (
    <Link
      to="/brands"
      className="flex h-full w-full snap-start flex-col items-center justify-center gap-1.5 rounded-2xl border border-border bg-surface p-2.5 text-center transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-elevate"
    >
      <div className="grid h-11 w-11 place-items-center rounded-full bg-primary/10 text-primary">
        <ArrowRight className="h-5 w-5" />
      </div>
      <span className="text-micro font-semibold text-primary">View all</span>
    </Link>
  );
}

export function BrandsSection({ brands }: { brands: Brand[] }) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-lg font-semibold">Best Selling Brands</h2>
        <Link to="/brands" className="text-xs font-semibold text-primary hover:underline">
          View all
        </Link>
      </div>
      <div className="no-scrollbar -mx-4 snap-x snap-mandatory overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6 md:-mx-10 md:px-10">
        <div className="grid grid-flow-col grid-rows-2 gap-2.5" style={{ gridAutoColumns: "5rem" }}>
          {brands.map((b) => (
            <BrandCard key={b.id} brand={b} />
          ))}
          <ViewAllCard />
        </div>
      </div>
    </section>
  );
}
