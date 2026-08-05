import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, ImagePlus, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

// Shown once, ever, per browser — the very first thing a new creator sees
// after finishing onboarding. Which pitch they get depends on how many pins
// they already have: plenty of pins → push them to monetise what's there;
// few/none → push them to create their first one. Intentionally has no
// backdrop-click or Escape dismiss — only the explicit Skip button closes it,
// so the choice to act or skip is always a deliberate one.
const STORAGE_KEY = "pinearn.newUserCtaSeen";

export function NewUserCta() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let alreadySeen = true;
    try {
      alreadySeen = localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      /* localStorage unavailable — fail closed, don't show */
    }
    setDismissed(alreadySeen);
    setReady(true);
  }, []);

  const { data: pinCount } = useQuery({
    queryKey: ["new-user-cta-pin-count"],
    queryFn: async () => {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes.user?.id;
      if (!userId) return 0;
      const { count } = await supabase
        .from("pins")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("is_owner", true);
      return count ?? 0;
    },
    enabled: ready && !dismissed,
  });

  useEffect(() => {
    if (dismissed) {
      document.body.style.overflow = "";
      return;
    }
    if (pinCount === undefined) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [dismissed, pinCount]);

  if (!ready || dismissed || pinCount === undefined) return null;

  const variant = pinCount > 1 ? "monetize" : "create";

  function dismiss() {
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      /* ignore quota/availability errors */
    }
    setDismissed(true);
  }

  function act() {
    dismiss();
    if (variant === "monetize") {
      navigate({ to: "/pins/attach", search: { intent: "monetize" } });
    } else {
      navigate({ to: "/pins/create" });
    }
  }

  return (
    <AnimatePresence>
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={variant === "monetize" ? "Monetise your pins" : "Create your first pin"}
        className="fixed inset-0 z-[100] flex items-center justify-center overflow-hidden bg-background/85 p-4 backdrop-blur-2xl"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
      >
        {/* Ambient glow blobs — purely decorative, sits behind the card */}
        <div className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-gradient-primary opacity-25 blur-3xl animate-blob" />
        <div className="pointer-events-none absolute -right-20 top-1/3 h-64 w-64 rounded-full bg-gradient-mint opacity-20 blur-3xl animate-blob-delay-2" />
        <div className="pointer-events-none absolute bottom-[-4rem] left-1/3 h-60 w-60 rounded-full bg-gradient-primary opacity-15 blur-3xl animate-blob-delay-4" />

        <motion.div
          initial={{ opacity: 0, y: 28, scale: 0.94 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="relative w-full max-w-sm overflow-hidden rounded-3xl border border-border bg-surface shadow-elevate sm:max-w-md"
        >
          {variant === "monetize" ? (
            <CtaCard
              icon={Sparkles}
              gradient="from-fuchsia-50 via-rose-100 to-orange-50"
              eyebrow="Ready to earn"
              headline={`${pinCount} pins are just sitting there`}
              body="Attach a product to any pin and start earning commission on every click. It takes less than a minute to go live."
              ctaLabel="Monetise my pins"
              onAct={act}
              onSkip={dismiss}
            />
          ) : (
            <CtaCard
              icon={ImagePlus}
              gradient="from-orange-100 via-amber-50 to-rose-50"
              eyebrow="Let's get started"
              headline="Create your first pin"
              body="Pins are how Pinearn turns your content into income. Create one now, attach a product, and start earning."
              ctaLabel="Create my first pin"
              onAct={act}
              onSkip={dismiss}
            />
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

function CtaCard({
  icon: Icon,
  gradient,
  eyebrow,
  headline,
  body,
  ctaLabel,
  onAct,
  onSkip,
}: {
  icon: typeof Sparkles;
  gradient: string;
  eyebrow: string;
  headline: string;
  body: string;
  ctaLabel: string;
  onAct: () => void;
  onSkip: () => void;
}) {
  return (
    <>
      <div
        className={`relative flex h-40 items-center justify-center overflow-hidden bg-gradient-to-br ${gradient}`}
      >
        <div className="absolute inset-0 opacity-40 [background:radial-gradient(circle_at_30%_20%,white,transparent_55%)]" />
        <motion.div
          initial={{ scale: 0.6, opacity: 0, rotate: -8 }}
          animate={{ scale: 1, opacity: 1, rotate: 0 }}
          transition={{ delay: 0.15, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="grid h-20 w-20 place-items-center rounded-3xl bg-white/85 text-primary shadow-glow backdrop-blur"
        >
          <Icon className="h-10 w-10" strokeWidth={2.2} />
        </motion.div>
      </div>

      <div className="px-6 pb-6 pt-6 text-center sm:px-8 sm:pb-8">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-primary">
          {eyebrow}
        </span>
        <h2 className="mt-1.5 font-display text-2xl font-bold leading-tight text-foreground">
          {headline}
        </h2>
        <p className="mx-auto mt-2.5 max-w-[30ch] text-sm leading-relaxed text-muted-foreground">
          {body}
        </p>

        <button
          type="button"
          onClick={onAct}
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-full bg-gradient-primary px-6 py-3.5 text-base font-semibold text-primary-foreground shadow-glow transition active:scale-[0.98]"
        >
          {ctaLabel} <ArrowRight className="h-[18px] w-[18px]" />
        </button>
        <button
          type="button"
          onClick={onSkip}
          className="mt-3.5 text-sm font-medium text-muted-foreground transition hover:text-foreground"
        >
          Skip for now
        </button>
      </div>
    </>
  );
}
