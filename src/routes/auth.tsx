import { createFileRoute, useNavigate, useSearch, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { motion } from "framer-motion";
import { supabase } from "@/integrations/supabase/client";
import { Checkbox } from "@/components/ui/checkbox";
import { notifyDone, notifyProblem } from "@/lib/notify";
import { ArrowRight, BarChart3, Loader2, Lock, Phone, Quote, Sparkles, Wand2 } from "lucide-react";

const searchSchema = z.object({
  redirect: z.string().optional(),
});

export const Route = createFileRoute("/auth")({
  ssr: false,
  validateSearch: (s) => searchSchema.parse(s),
  component: AuthPage,
});

type Step = "phone" | "otp";

const COUNTRIES = [
  { code: "IN", dial: "+91", flag: "🇮🇳", name: "India" },
  { code: "US", dial: "+1", flag: "🇺🇸", name: "United States" },
  { code: "GB", dial: "+44", flag: "🇬🇧", name: "United Kingdom" },
  { code: "CA", dial: "+1", flag: "🇨🇦", name: "Canada" },
  { code: "AU", dial: "+61", flag: "🇦🇺", name: "Australia" },
  { code: "AE", dial: "+971", flag: "🇦🇪", name: "UAE" },
  { code: "SG", dial: "+65", flag: "🇸🇬", name: "Singapore" },
  { code: "DE", dial: "+49", flag: "🇩🇪", name: "Germany" },
  { code: "FR", dial: "+33", flag: "🇫🇷", name: "France" },
  { code: "BR", dial: "+55", flag: "🇧🇷", name: "Brazil" },
  { code: "JP", dial: "+81", flag: "🇯🇵", name: "Japan" },
] as const;

// What the brand panel pitches while someone waits to sign in — kept in sync
// with the landing page's own feature language so the story never breaks.
const PITCH_POINTS = [
  { icon: Wand2, text: "AI matches a real product to every pin, automatically." },
  { icon: Sparkles, text: "Pinterest SEO tuning built into every pin and board." },
  { icon: BarChart3, text: "Real impressions, clicks, and earnings in one dashboard." },
];

async function routeAfterAuth(
  navigate: ReturnType<typeof useNavigate>,
  fallback: string,
  userId: string,
) {
  const { data: profile } = await supabase
    .from("profiles")
    .select("onboarding_completed")
    .eq("id", userId)
    .maybeSingle();
  if (profile?.onboarding_completed) navigate({ to: fallback as string });
  else navigate({ to: "/onboarding" });
}

function AuthPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: "/auth" });
  const fallback = (search.redirect as string) ?? "/dashboard";

  const [step, setStep] = useState<Step>("phone");
  const [agreed, setAgreed] = useState(false);
  const [countryIdx, setCountryIdx] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [localPhone, setLocalPhone] = useState("7777777777");
  const [phone, setPhone] = useState(""); // full E.164 after send
  const [otp, setOtp] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const phoneRef = useRef<HTMLInputElement | null>(null);
  const country = COUNTRIES[countryIdx];

  useEffect(() => {
    // Always sign out on landing so OTP flow runs from scratch.
    supabase.auth.signOut().catch(() => {});
  }, []);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const DUMMY_OTP = "123456";
  const dummyEmailFor = (p: string) => `phone${p.replace(/[^\d]/g, "")}@pinearn.dev`;
  const dummyPasswordFor = (p: string) => `pinearn-otp-${p.replace(/[^\d]/g, "")}`;

  const [otpError, setOtpError] = useState(false);
  const digitRefs = useRef<Array<HTMLInputElement | null>>([]);

  async function sendCode(e?: React.FormEvent) {
    e?.preventDefault();
    const currentPhone = phoneRef.current?.value ?? localPhone;
    const digits = currentPhone.replace(/[^\d]/g, "").slice(0, 10);
    if (digits.length !== 10) {
      return notifyProblem("Enter a valid 10-digit phone number");
    }
    const p = `${country.dial}${digits}`;
    setLocalPhone(digits);
    setSending(true);
    await new Promise((r) => setTimeout(r, 400));
    setPhone(p);
    setOtp("");
    setOtpError(false);
    setStep("otp");
    setResendIn(30);
    setTimeout(() => digitRefs.current[0]?.focus(), 100);
    setSending(false);
  }

  function handleDigitChange(i: number, val: string) {
    const d = val.replace(/\D/g, "").slice(-1);
    const arr = otp.padEnd(6, " ").split("");
    arr[i] = d || " ";
    const next = arr.join("").trimEnd();
    setOtp(next);
    setOtpError(false);
    if (d && i < 5) digitRefs.current[i + 1]?.focus();
  }

  function handleDigitKey(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !e.currentTarget.value && i > 0) {
      digitRefs.current[i - 1]?.focus();
    }
  }

  function handleDigitPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (!text) return;
    e.preventDefault();
    setOtp(text);
    setOtpError(false);
    digitRefs.current[Math.min(text.length, 5)]?.focus();
  }

  async function verifyCode(e?: React.FormEvent) {
    e?.preventDefault();
    if (otp.trim() !== DUMMY_OTP) {
      setOtpError(true);
      return;
    }
    setVerifying(true);
    try {
      const email = dummyEmailFor(phone);
      const password = dummyPasswordFor(phone);
      let { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        const { error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { display_name: phone } },
        });
        if (signUpError) throw signUpError;
        ({ data, error } = await supabase.auth.signInWithPassword({ email, password }));
        if (error) throw error;
      }
      if (!data.user) throw new Error("Verification failed");
      notifyDone("Signed in");
      await routeAfterAuth(navigate, fallback, data.user.id);
    } catch (err) {
      setOtpError(true);
      notifyProblem(err instanceof Error ? err.message : "Invalid code");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-2">
      {/* -------------------------------------------------------------- */}
      {/* Left — brand story panel, desktop only                         */}
      {/* -------------------------------------------------------------- */}
      <div className="relative hidden overflow-hidden bg-gradient-hero lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage: `radial-gradient(circle, var(--foreground) 1px, transparent 1px)`,
            backgroundSize: "32px 32px",
          }}
          aria-hidden
        />
        <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
          <div className="animate-blob absolute -left-20 -top-20 h-96 w-96 rounded-full bg-primary/20 blur-[100px]" />
          <div className="animate-blob-delay-2 absolute -right-16 top-1/3 h-80 w-80 rounded-full bg-accent/25 blur-[90px]" />
          <div className="animate-blob-delay-4 absolute bottom-[-6rem] left-1/4 h-[26rem] w-[26rem] rounded-full bg-chart-5/15 blur-[120px]" />
          <div className="animate-float absolute left-[12%] top-[20%] h-4 w-4 rotate-45 rounded-sm bg-primary/30" />
          <div className="animate-float-delay absolute right-[18%] top-[30%] h-3 w-3 rounded-full bg-accent/40" />
          <div className="animate-float absolute left-[20%] bottom-[28%] h-5 w-5 rounded-lg bg-chart-5/25" />
        </div>

        <Link to="/" className="relative z-10 flex items-center gap-2">
          <img src="/shopmypin-logo.png" alt="" draggable={false} className="h-8 w-8" />
          <span className="font-display text-lg font-semibold">ShopMyPin</span>
        </Link>

        <div className="relative z-10 max-w-md">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-surface/70 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
            <Sparkles className="h-3 w-3 text-primary" />
            Real Pinterest data. Real earnings.
          </div>
          <h1 className="mt-5 font-display text-3xl font-semibold leading-tight tracking-tight xl:text-4xl">
            Turn your Pinterest into a <span className="text-gradient">paycheck</span>.
          </h1>
          <ul className="mt-7 space-y-4">
            {PITCH_POINTS.map((p) => (
              <li key={p.text} className="flex items-start gap-3">
                <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-surface/80 text-primary shadow-sm backdrop-blur">
                  <p.icon className="h-4 w-4" />
                </span>
                <span className="pt-1 text-sm text-foreground/85">{p.text}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative z-10 max-w-md rounded-2xl border border-border bg-surface/80 p-5 shadow-elevate backdrop-blur">
          <Quote className="h-5 w-5 text-primary/50" />
          <p className="mt-2 text-sm leading-relaxed text-foreground/85">
            “ShopMyPin found products for Pins I'd posted years ago — that old Pinterest traffic
            finally pays me.”
          </p>
          <p className="mt-3 text-xs font-semibold text-muted-foreground">Creator name · @handle</p>
        </div>
      </div>

      {/* -------------------------------------------------------------- */}
      {/* Right — the sign-in card                                       */}
      {/* -------------------------------------------------------------- */}
      <div className="relative flex items-center justify-center overflow-hidden px-4 py-10 sm:px-6">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.03] lg:hidden"
          style={{
            backgroundImage: `radial-gradient(circle, var(--foreground) 1px, transparent 1px)`,
            backgroundSize: "32px 32px",
          }}
          aria-hidden
        />
        <div className="pointer-events-none absolute inset-0 overflow-hidden lg:hidden" aria-hidden>
          <div className="animate-blob absolute -left-20 -top-20 h-80 w-80 rounded-full bg-primary/15 blur-[100px]" />
          <div className="animate-blob-delay-2 absolute -right-16 top-1/4 h-72 w-72 rounded-full bg-accent/20 blur-[90px]" />
        </div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
          className="relative z-10 mx-auto w-full max-w-[26rem]"
        >
          {/* On mobile the brand sits in the flow directly above the card, not
              pinned to the corner. Pinned, it read as a stray element with an
              empty band under it and the card floating unanchored below —
              stacking them makes one centred composition instead of two. */}
          <Link to="/" className="mb-7 flex items-center justify-center gap-2.5 lg:hidden">
            <img
              src="/shopmypin-logo.png"
              alt=""
              draggable={false}
              className="h-9 w-9 rounded-[10px]"
            />
            <span className="font-display text-lg font-semibold tracking-tight">ShopMyPin</span>
          </Link>

          <div className="rounded-3xl border border-border bg-surface/90 p-6 shadow-elevate backdrop-blur-xl sm:p-8">
            <h1 className="font-display text-[1.6rem] font-semibold leading-tight tracking-tight">
              {step === "phone" ? "Welcome to ShopMyPin" : "Enter the code"}
            </h1>
            {/* Only the OTP step gets a sub-line, and only because the number
                the code went to is information the heading can't carry. On the
                phone step it restated the heading, the field's placeholder and
                the button, all of which are on screen at once. */}
            {step === "otp" && (
              <p className="mt-2 text-sm text-muted-foreground">We sent a code to {phone}</p>
            )}

            {step === "phone" ? (
              <form onSubmit={sendCode} className="mt-5">
                {/* The field is a flag, a dial code and a number pad — a label
                    saying "Phone Number" over it is the same word twice. */}
                <div className="flex items-stretch gap-2.5">
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setPickerOpen((v) => !v)}
                      className="flex h-14 items-center gap-2 rounded-2xl border border-input bg-surface-2 px-4 text-base font-medium tabular-nums transition hover:bg-surface focus-visible:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/15"
                      aria-label="Select country"
                      aria-expanded={pickerOpen}
                    >
                      <span className="text-lg leading-none">{country.flag}</span>
                      <span>{country.dial}</span>
                    </button>
                    {pickerOpen && (
                      <div className="absolute left-0 top-[calc(100%+8px)] z-40 max-h-64 w-64 overflow-auto rounded-2xl border border-border bg-surface p-1.5 shadow-elevate">
                        {COUNTRIES.map((c, i) => (
                          <button
                            type="button"
                            key={c.code}
                            onClick={() => {
                              setCountryIdx(i);
                              setPickerOpen(false);
                            }}
                            className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-base transition hover:bg-surface-2 ${
                              i === countryIdx ? "bg-surface-2" : ""
                            }`}
                          >
                            <span className="text-lg leading-none">{c.flag}</span>
                            <span className="flex-1 truncate">{c.name}</span>
                            <span className="text-muted-foreground">{c.dial}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex h-14 flex-1 items-center gap-2.5 rounded-2xl border border-input bg-background px-3.5 transition focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/15">
                    <Phone className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <input
                      ref={phoneRef}
                      type="tel"
                      required
                      autoComplete="tel-national"
                      inputMode="numeric"
                      value={localPhone}
                      maxLength={10}
                      onChange={(e) =>
                        setLocalPhone(e.target.value.replace(/\D/g, "").slice(0, 10))
                      }
                      aria-label="Phone number"
                      placeholder="Phone number"
                      className="min-w-0 flex-1 bg-transparent text-base tabular-nums tracking-wide outline-none placeholder:tracking-normal placeholder:text-muted-foreground"
                    />
                  </div>
                </div>
                <div className="mt-5 flex items-start gap-3">
                  <Checkbox
                    id="consent"
                    checked={agreed}
                    onCheckedChange={(v) => setAgreed(v === true)}
                    className="mt-0.5 h-[18px] w-[18px] rounded-[5px] border-input data-[state=checked]:border-primary"
                  />
                  <label
                    htmlFor="consent"
                    className="cursor-pointer select-none text-sm leading-relaxed text-muted-foreground"
                  >
                    I agree to the{" "}
                    <Link
                      to="/privacy"
                      target="_blank"
                      className="font-medium text-foreground underline decoration-border underline-offset-2 transition hover:decoration-foreground"
                    >
                      Privacy Policy
                    </Link>{" "}
                    and{" "}
                    <Link
                      to="/terms"
                      target="_blank"
                      className="font-medium text-foreground underline decoration-border underline-offset-2 transition hover:decoration-foreground"
                    >
                      Terms and Conditions
                    </Link>
                    .
                  </label>
                </div>
                {/* The disabled state is a NEUTRAL control, not a faded copy of the
                    primary gradient. A washed-out brand button is the single thing
                    that made this screen read as broken rather than as waiting:
                    a pale pink "Get OTP" looks like a render bug, while a grey one
                    obviously means "not yet". */}
                <button
                  type="submit"
                  disabled={sending || !agreed}
                  className="mt-5 flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-base font-semibold transition-all enabled:bg-gradient-primary enabled:text-primary-foreground enabled:shadow-glow enabled:hover:brightness-[1.05] enabled:active:scale-[0.99] disabled:cursor-not-allowed disabled:border disabled:border-border disabled:bg-surface-2 disabled:text-muted-foreground"
                >
                  {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
                  {sending ? "Sending…" : "Get OTP"}
                  {!sending && agreed && <ArrowRight className="h-4 w-4" />}
                </button>

                <p className="mt-5 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                  <Lock className="h-3 w-3 shrink-0" /> Your number is only ever used to sign you
                  in.
                </p>
              </form>
            ) : (
              <form onSubmit={verifyCode} className="mt-5">
                {otpError && (
                  <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive">
                    <span className="grid h-5 w-5 place-items-center rounded-full border border-destructive text-xs">
                      !
                    </span>
                    Incorrect OTP. Please try again.
                  </div>
                )}
                {/* Six boxes under "Enter the code" don't need a line telling
                    you to enter six digits. The dummy-OTP hint stays: no SMS is
                    actually sent in this build, so it is the only way in. */}
                <p className="mb-3 text-center text-xs text-muted-foreground/70">
                  Dummy OTP is 123456
                </p>
                <div className="flex items-center justify-center gap-1 sm:gap-1.5">
                  {Array.from({ length: 6 }).map((_, i) => {
                    const val = otp[i] ?? "";
                    const focused = otp.length === i;
                    return (
                      <input
                        key={i}
                        ref={(el) => {
                          digitRefs.current[i] = el;
                        }}
                        type="text"
                        inputMode="numeric"
                        autoComplete={i === 0 ? "one-time-code" : "off"}
                        pattern="[0-9]*"
                        maxLength={1}
                        value={val}
                        onChange={(e) => handleDigitChange(i, e.target.value)}
                        onKeyDown={(e) => handleDigitKey(i, e)}
                        onPaste={handleDigitPaste}
                        onFocus={(e) => e.currentTarget.select()}
                        className={`aspect-square rounded-2xl border bg-surface-2 text-center font-display text-2xl font-semibold outline-none transition-all ${
                          otpError
                            ? "border-destructive/50"
                            : focused || val
                              ? "border-primary ring-2 ring-primary/30 scale-110 bg-background shadow-glow"
                              : "border-border"
                        } ${focused || val ? "w-12 h-12 text-xl sm:w-14 sm:h-14 sm:text-2xl" : "w-11 h-11 text-lg sm:w-14 sm:h-14 sm:text-2xl"}`}
                      />
                    );
                  })}
                </div>
                <button
                  type="submit"
                  disabled={verifying || otp.length < 6}
                  className="mt-6 flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-base font-semibold transition-all enabled:bg-gradient-primary enabled:text-primary-foreground enabled:shadow-glow enabled:hover:brightness-[1.05] enabled:active:scale-[0.99] disabled:cursor-not-allowed disabled:border disabled:border-border disabled:bg-surface-2 disabled:text-muted-foreground"
                >
                  {verifying ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
                  {verifying ? "Verifying…" : "Verify & Continue"}
                </button>

                <div className="mt-4 flex items-center justify-center gap-3 text-sm">
                  <span className="text-muted-foreground">
                    {resendIn > 0 ? (
                      `Resend in ${resendIn}s`
                    ) : (
                      <button
                        type="button"
                        onClick={() => sendCode()}
                        disabled={sending}
                        className="font-medium text-primary"
                      >
                        {sending ? "Sending…" : "Resend"}
                      </button>
                    )}
                  </span>
                  <span className="text-border">·</span>
                  <button
                    type="button"
                    onClick={() => {
                      setStep("phone");
                      setOtp("");
                      setOtpError(false);
                    }}
                    className="font-semibold text-foreground hover:text-primary"
                  >
                    Change number
                  </button>
                </div>
              </form>
            )}
          </div>
        </motion.div>
      </div>
    </div>
  );
}
