import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  computeHealthReport,
  type HealthBoard,
  type HealthPin,
  type HealthProfile,
} from "@/lib/health-score";

// One query key for everything Health Score reads — the fix flows invalidate
// this after applying suggestions so the dashboard re-scores immediately.
export const HEALTH_SCORE_QUERY_KEY = ["health-score-data"];

export type HealthData = {
  pins: HealthPin[];
  boards: HealthBoard[];
  profile: HealthProfile;
};

async function fetchHealthData(): Promise<HealthData> {
  const { data: userRes } = await supabase.auth.getUser();
  const userId = userRes.user?.id;
  const empty: HealthData = {
    pins: [],
    boards: [],
    profile: { bioFilled: false, avatarSet: false, websiteClaimed: false, socialLinked: false },
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
    profile: {
      // Bio = the storefront description — the closest field we own to a bio.
      bioFilled: !!storefrontRes.data?.description?.trim(),
      avatarSet: !!profileRes.data?.avatar_url?.trim(),
      // Website claimed = their public storefront link is live.
      websiteClaimed: !!storefrontRes.data?.is_published,
      // Social link = Pinterest account connected.
      socialLinked: !!profileRes.data?.pinterest_connected,
    },
  };
}

/** Everything the Health Score surfaces need: raw data + the computed report. */
export function useHealthScore() {
  const query = useQuery({ queryKey: HEALTH_SCORE_QUERY_KEY, queryFn: fetchHealthData });

  const report = useMemo(
    () =>
      query.data
        ? computeHealthReport(query.data.pins, query.data.boards, query.data.profile)
        : null,
    [query.data],
  );

  return { ...query, report };
}
