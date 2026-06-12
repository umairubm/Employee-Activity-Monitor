import { useCallback, useEffect } from "react";
import { format } from "date-fns";
import { ChevronLeft, ChevronRight, Flag } from "lucide-react";
import type { ScreenshotListItem } from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Full-size screenshot viewer with left/right navigation across a list of
 * screenshots. Navigate with the on-screen arrows or the Left/Right arrow keys.
 * Controlled: the parent owns the open state and the current index.
 */
export function ScreenshotLightbox({
  screenshots,
  index,
  onIndexChange,
  open,
  onOpenChange,
}: {
  screenshots: ScreenshotListItem[];
  index: number;
  onIndexChange: (index: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const count = screenshots.length;
  const current = screenshots[index];

  const goPrev = useCallback(() => {
    if (count === 0) return;
    onIndexChange((index - 1 + count) % count);
  }, [count, index, onIndexChange]);

  const goNext = useCallback(() => {
    if (count === 0) return;
    onIndexChange((index + 1) % count);
  }, [count, index, onIndexChange]);

  // Keep the viewer coherent if the underlying list shrinks while open
  // (e.g. a filter/date change refetches fewer screenshots).
  useEffect(() => {
    if (!open) return;
    if (count === 0) {
      onOpenChange(false);
    } else if (index > count - 1) {
      onIndexChange(count - 1);
    }
  }, [open, count, index, onIndexChange, onOpenChange]);

  useEffect(() => {
    if (!open || count <= 1) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, count, goPrev, goNext]);

  if (!current) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl border-none bg-black/95 p-1 shadow-2xl">
        <DialogHeader className="sr-only">
          <DialogTitle>
            Screenshot from {format(new Date(current.capturedAt), "PPpp")}
          </DialogTitle>
        </DialogHeader>
        <div className="relative">
          <img
            src={current.imageUrl}
            alt="Screenshot full size"
            className="h-auto max-h-[85vh] w-full rounded-md object-contain"
          />

          {count > 1 && (
            <>
              <button
                type="button"
                aria-label="Previous screenshot"
                onClick={goPrev}
                className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full border border-white/10 bg-black/60 p-2 text-white backdrop-blur-md transition-colors hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                <ChevronLeft className="h-6 w-6" />
              </button>
              <button
                type="button"
                aria-label="Next screenshot"
                onClick={goNext}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full border border-white/10 bg-black/60 p-2 text-white backdrop-blur-md transition-colors hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                <ChevronRight className="h-6 w-6" />
              </button>
            </>
          )}

          {current.flagged && (
            <div className="absolute left-4 top-4 flex items-center gap-1 rounded-md bg-amber-500 px-2 py-0.5 text-xs font-medium text-white">
              <Flag className="h-3 w-3" /> Flagged
            </div>
          )}

          <div className="absolute bottom-4 left-4 rounded-md border border-white/10 bg-black/70 px-3 py-1.5 text-sm text-white backdrop-blur-md">
            {format(new Date(current.capturedAt), "PPpp")}
          </div>

          {count > 1 && (
            <div className="absolute bottom-4 right-4 rounded-md border border-white/10 bg-black/70 px-3 py-1.5 text-sm text-white backdrop-blur-md">
              {index + 1} / {count}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
