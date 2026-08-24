import type { ReactNode } from "react";
import { Copy, Facebook, Mail, MessageCircle, Send, Share2, Twitter } from "lucide-react";
import { notifyDone, notifyProblem } from "@/lib/notify";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/* ============================================================================
   One share sheet, used everywhere something has a public link.

   This was written inline on the storefront header for the store link, and the
   moment collections needed the same eight channels the choice was to duplicate
   ~100 lines or lift it here. Duplicating share targets is how you end up with
   a WhatsApp button that works on one screen and a stale URL format on another.

   Every target takes the SAME `url`, so a caller only has to get the link
   right — see src/lib/share-links.ts for the link-building itself.
   ========================================================================== */

function PinterestGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
      <path d="M12 0C5.4 0 0 5.4 0 12c0 5 3.1 9.4 7.5 11.1-.1-.9-.2-2.4 0-3.4.2-.9 1.4-5.7 1.4-5.7s-.4-.7-.4-1.8c0-1.7 1-2.9 2.2-2.9 1 0 1.5.8 1.5 1.7 0 1-.7 2.6-1 4-.3 1.2.6 2.1 1.7 2.1 2.1 0 3.7-2.2 3.7-5.4 0-2.8-2-4.8-4.9-4.8-3.3 0-5.3 2.5-5.3 5.1 0 1 .4 2.1.9 2.7.1.1.1.2.1.3-.1.4-.3 1.2-.3 1.4-.1.2-.2.3-.4.2-1.5-.7-2.4-2.9-2.4-4.6 0-3.8 2.7-7.2 7.9-7.2 4.1 0 7.3 3 7.3 6.9 0 4.1-2.6 7.5-6.2 7.5-1.2 0-2.4-.6-2.8-1.4l-.7 2.9c-.3 1-1 2.3-1.5 3.1 1.1.3 2.3.5 3.5.5 6.6 0 12-5.4 12-12S18.6 0 12 0z" />
    </svg>
  );
}

export function SharePopover({
  url,
  title,
  text,
  align = "end",
  children,
}: {
  url: string;
  /** Used as the subject/title where a channel has one (email, native sheet). */
  title: string;
  /** The message that travels with the link. */
  text: string;
  align?: "start" | "center" | "end";
  children: ReactNode;
}) {
  const encodedUrl = encodeURIComponent(url);
  const encodedText = encodeURIComponent(text);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      notifyDone("Link copied");
    } catch {
      // Clipboard is permission-gated and throws on an insecure origin. Saying
      // so beats a button that silently does nothing.
      notifyProblem("Couldn't copy — long-press the link to copy it manually");
    }
  }

  const items: { label: string; icon: ReactNode; onClick: () => void }[] = [
    {
      label: "Pinterest",
      icon: <PinterestGlyph />,
      onClick: () =>
        window.open(
          `https://pinterest.com/pin/create/button/?url=${encodedUrl}&description=${encodedText}`,
          "_blank",
          "noopener,noreferrer",
        ),
    },
    {
      label: "WhatsApp",
      icon: <MessageCircle className="h-5 w-5" />,
      onClick: () =>
        window.open(
          `https://wa.me/?text=${encodedText}%20${encodedUrl}`,
          "_blank",
          "noopener,noreferrer",
        ),
    },
    {
      label: "Telegram",
      icon: <Send className="h-5 w-5" />,
      onClick: () =>
        window.open(
          `https://t.me/share/url?url=${encodedUrl}&text=${encodedText}`,
          "_blank",
          "noopener,noreferrer",
        ),
    },
    {
      label: "X",
      icon: <Twitter className="h-5 w-5" />,
      onClick: () =>
        window.open(
          `https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodedText}`,
          "_blank",
          "noopener,noreferrer",
        ),
    },
    {
      label: "Facebook",
      icon: <Facebook className="h-5 w-5" />,
      onClick: () =>
        window.open(
          `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
          "_blank",
          "noopener,noreferrer",
        ),
    },
    {
      label: "Email",
      icon: <Mail className="h-5 w-5" />,
      onClick: () => {
        window.location.href = `mailto:?subject=${encodeURIComponent(title)}&body=${encodedText}%20${encodedUrl}`;
      },
    },
    {
      label: "More",
      icon: <Share2 className="h-5 w-5" />,
      onClick: async () => {
        if (navigator.share) {
          try {
            await navigator.share({ title, text, url });
            return;
          } catch {
            /* user dismissed the native share sheet */
          }
        } else {
          copy();
        }
      },
    },
    {
      label: "Copy",
      icon: <Copy className="h-5 w-5" />,
      onClick: copy,
    },
  ];

  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-64 p-2">
        <div className="grid grid-cols-4 gap-1">
          {items.map((it) => (
            <button
              key={it.label}
              onClick={it.onClick}
              className="flex flex-col items-center gap-1 rounded-lg p-2 text-micro font-medium text-foreground hover:bg-surface-2"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-2">
                {it.icon}
              </span>
              {it.label}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
