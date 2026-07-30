import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getUserAccount, PinterestAuthError } from "@/lib/pinterest-api";
import { withPinterestToken } from "@/lib/pinterest-oauth.functions";

/**
 * The creator's Pinterest profile, read live from Pinterest.
 *
 * Profile Completeness scores the PINTEREST profile, not the Pinearn storefront:
 * the bio, photo and website that decide whether a pin's traffic turns into a
 * follow live on pinterest.com, and a fully-filled storefront never moved them.
 * Nothing here is writable — Pinterest owns these fields, so the product's job is
 * to report what's missing and hand over a link to the exact settings page.
 *
 * Never throws for the ordinary "can't read it" cases (not connected, token
 * revoked, trial-tier account): those come back as `connected: false` with a
 * reason, because the health score has to keep working when Pinterest doesn't.
 */
export type PinterestProfileSnapshot = {
  connected: boolean;
  /** Why it couldn't be read, when connected is false. */
  reason: string | null;
  username: string | null;
  about: string | null;
  websiteUrl: string | null;
  profileImage: string | null;
  businessName: string | null;
  accountType: string | null;
  followerCount: number;
  pinCount: number;
  boardCount: number;
  monthlyViews: number;
};

const DISCONNECTED: PinterestProfileSnapshot = {
  connected: false,
  reason: "Pinterest isn't connected",
  username: null,
  about: null,
  websiteUrl: null,
  profileImage: null,
  businessName: null,
  accountType: null,
  followerCount: 0,
  pinCount: 0,
  boardCount: 0,
  monthlyViews: 0,
};

export const getPinterestProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PinterestProfileSnapshot> => {
    try {
      const account = await withPinterestToken(context.userId, (t) => getUserAccount(t));
      return {
        connected: true,
        reason: null,
        username: account.username,
        about: account.about,
        websiteUrl: account.websiteUrl,
        profileImage: account.profileImage,
        businessName: account.businessName,
        accountType: account.accountType,
        followerCount: account.followerCount,
        pinCount: account.pinCount,
        boardCount: account.boardCount,
        monthlyViews: account.monthlyViews,
      };
    } catch (e) {
      const reason =
        e instanceof PinterestAuthError
          ? "Pinterest needs reconnecting"
          : e instanceof Error
            ? e.message
            : "Couldn't reach Pinterest";
      return { ...DISCONNECTED, reason };
    }
  });
