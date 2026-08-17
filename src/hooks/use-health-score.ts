import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import {
  computeHealthReport,
  type HealthBoard,
  type HealthPin,
  type HealthProfile,
} from "@/lib/health-score";
import {
  getPinterestProfile,
  type PinterestProfileSnapshot,
} from "@/lib/pinterest-profile.functions";

// One query key for everything Health Score reads — the fix flows invalidate
// this after applying suggestions so the dashboard re-scores immediately.
export const HEALTH_SCORE_QUERY_KEY = ["health-score-data"];

// The Pinterest profile is a separate query on purpose. It's a round trip to
// Pinterest's API, and every fix flow invalidates the health data on exit — folding
// it into the same request would have made the pins/boards the deck needs wait on
// a third-party call each time. Its own key means it caches for minutes, refreshes
// independently, and the score simply recomputes when it lands.
export const PINTEREST_PROFILE_QUERY_KEY = ["pinterest-profile"];

export type HealthData = {
  pins: HealthPin[];
  boards: HealthBoard[];
  profile: HealthProfile;
  // The raw Pinterest profile behind the profile sub-score, so the fix sheet can
  // show the creator their actual bio/website instead of just pass/fail.
  pinterestProfile: PinterestProfileSnapshot | null;
};

async function fetchHealthData(): Promise<HealthData> {
  const { data: userRes } = await supabase.auth.getUser();
  const userId = userRes.user?.id;
  const empty: HealthData = {
    pins: [],
    boards: [],
    profile: { bioFilled: false, avatarSet: false, websiteClaimed: false, socialLinked: false },
    pinterestProfile: null,
  };
  if (!userId) return empty;

  const [pinsRes, boardsRes, profileRes, storefrontRes] = await Promise.all([
    supabase
      .from("pins")
      // origin_collection_id matters: once a pin goes live it is re-homed into
      // its own per-pin collection, and only this column still remembers which
      // real board it came from. Without it, a board whose pins are all live
      // looks empty — no covers, and falsely stale.
      .select(
        "id, title, description, image_url, collection_id, origin_collection_id, impressions, clicks, created_at",
      )
      .eq("user_id", userId)
      .eq("is_owner", true)
      // Flagged gone from Pinterest — see pins_.attach.tsx. Scoring them would
      // hold the Boost score down over pins the creator can no longer fix, and
      // feed the rewrite deck cards that apply to nothing.
      .is("pinterest_removed_at", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("collections")
      // `collections` holds two unrelated things: real Pinterest boards
      // (source 'pinterest', pinterest_board_id set) and local storefront
      // groupings — including one auto-created per pin that goes live, named
      // from the pin title or "Pin collection". Only the former are boards
      // that exist on Pinterest and can rank there, so only those belong in
      // the Board Structure score and the Board Boost deck. Scoring the
      // per-pin containers as undescribed "boards" was both wrong and a
      // permanent drag on the score.
      .select("id, name, description, cover_image_url")
      .eq("user_id", userId)
      .not("pinterest_board_id", "is", null)
      .order("position", { ascending: true }),
    supabase
      .from("profiles")
      .select("avatar_url, pinterest_connected")
      .eq("id", userId)
      .maybeSingle(),
    supabase
      .from("storefronts")
      .select("description, is_published")
      .eq("user_id", userId)
      .order("is_default", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  return {
    pins: (pinsRes.data ?? []) as HealthPin[],
    boards: (boardsRes.data ?? []) as HealthBoard[],
    // The local fallback, used until (or unless) the Pinterest profile can be
    // read — see mergePinterestProfile below.
    profile: {
      bioFilled: !!storefrontRes.data?.description?.trim(),
      avatarSet: !!profileRes.data?.avatar_url?.trim(),
      websiteClaimed: !!storefrontRes.data?.is_published,
      socialLinked: !!profileRes.data?.pinterest_connected,
      fromPinterest: false,
    },
    pinterestProfile: null,
  };
}

/** Profile Completeness scores the PINTEREST profile — the page a pin's traffic
 * actually lands on. When Pinterest can't be read (not connected, token revoked,
 * trial-tier account) the local signals stand in and `fromPinterest` stays false,
 * so the UI can say the score is a stand-in instead of reporting an unknown
 * profile as an empty one. */
function mergePinterestProfile(
  data: HealthData,
  snapshot: PinterestProfileSnapshot | undefined,
): HealthData {
  if (!snapshot?.connected) return { ...data, pinterestProfile: snapshot ?? null };
  return {
    ...data,
    profile: {
      bioFilled: !!snapshot.about,
      avatarSet: !!snapshot.profileImage,
      websiteClaimed: !!snapshot.websiteUrl,
      socialLinked: true,
      fromPinterest: true,
    },
    pinterestProfile: snapshot,
  };
}

/** Everything the Health Score surfaces need: raw data + the computed report. */
export function useHealthScore() {
  const loadPinterestProfile = useServerFn(getPinterestProfile);
  const query = useQuery({ queryKey: HEALTH_SCORE_QUERY_KEY, queryFn: fetchHealthData });
  const profileQuery = useQuery({
    queryKey: PINTEREST_PROFILE_QUERY_KEY,
    queryFn: () => loadPinterestProfile(),
    // Pinterest profiles change once in a blue moon, and the handler never
    // throws — so cache it hard and don't retry a failure into a stampede.
    staleTime: 5 * 60_000,
    retry: false,
  });

  const data = useMemo(
    () => (query.data ? mergePinterestProfile(query.data, profileQuery.data) : undefined),
    [query.data, profileQuery.data],
  );

  const report = useMemo(
    () => (data ? computeHealthReport(data.pins, data.boards, data.profile) : null),
    [data],
  );

  return {
    ...query,
    data,
    // Both halves feed one score, so callers see one loading/refetch surface.
    isFetching: query.isFetching || profileQuery.isFetching,
    refetch: async () => {
      const [health] = await Promise.all([query.refetch(), profileQuery.refetch()]);
      return health;
    },
    report,
  };
}
