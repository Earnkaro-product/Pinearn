// Best-effort product images for pasted links.
//
// A product added by URL has no image of its own — nothing in the pipeline
// ever sees the page behind the link. This fn fetches the page server-side
// (retailer pages block cross-origin reads, so the client can't) and pulls
// the og:image / twitter:image out of the <head>. Every failure mode —
// blocked bot, timeout, no meta tag, not HTML — degrades to null; callers
// treat an image as a bonus, never a requirement.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const MAX_LINKS = 10;
const FETCH_TIMEOUT_MS = 5000;
// og tags live in <head>; stop reading once it closes (or at this cap) so a
// huge product page never buffers whole.
const MAX_HTML_CHARS = 300_000;

// This fetches user-supplied URLs from the server, so refuse anything that
// could point inside the network: raw IPs, localhost, internal-looking hosts.
function isDisallowedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h.includes(":") || h.startsWith("[")) return true; // IPv6 literal
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return false;
}

async function readHtmlHead(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let html = "";
  while (html.length < MAX_HTML_CHARS) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
    if (/<\/head/i.test(html)) break;
  }
  void reader.cancel().catch(() => {});
  return html;
}

function extractMetaImage(html: string, baseUrl: string): string | null {
  // Ranked by fidelity; attribute order inside the tag varies per site, so
  // each <meta> is parsed for property/name and content independently.
  const wanted = ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"];
  let best: { rank: number; url: string } | null = null;
  for (const tag of html.match(/<meta\s[^>]*>/gi) ?? []) {
    const prop = tag
      .match(/(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]
      ?.trim()
      .toLowerCase();
    if (!prop) continue;
    const rank = wanted.indexOf(prop);
    if (rank === -1 || (best && best.rank <= rank)) continue;
    const content = tag.match(/content\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
    if (!content) continue;
    best = { rank, url: content };
    if (rank === 0) break;
  }
  if (!best) return null;
  try {
    const abs = new URL(best.url.replace(/&amp;/g, "&"), baseUrl);
    return abs.protocol === "https:" || abs.protocol === "http:" ? abs.toString() : null;
  } catch {
    return null;
  }
}

async function fetchOgImage(url: string): Promise<string | null> {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (isDisallowedHost(u.hostname)) return null;
    const res = await fetch(u.toString(), {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        // Retailer pages serve og tags to browsers but often 403 a bare
        // fetch UA.
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(contentType)) return null;
    const html = await readHtmlHead(res);
    return extractMetaImage(html, res.url || u.toString());
  } catch {
    return null;
  }
}

export const fetchLinkPreviews = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d: { urls: string[] }) =>
    z.object({ urls: z.array(z.string().url()).min(1).max(MAX_LINKS) }).parse(d),
  )
  .handler(async ({ data }): Promise<{ images: (string | null)[] }> => {
    const images = await Promise.all(data.urls.map((u) => fetchOgImage(u)));
    return { images };
  });
