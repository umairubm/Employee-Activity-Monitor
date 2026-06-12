import React, { useMemo, useState } from "react";
import {
  useListScreenshots,
  getListScreenshotsQueryKey,
  useFlagScreenshot,
  useListDevices,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { format } from "date-fns";
import { Image as ImageIcon, Info, Flag } from "lucide-react";
import { ScreenshotLightbox } from "@/components/ScreenshotLightbox";
import { useToast } from "@/hooks/use-toast";
import { useGroupFilter, ALL_GROUPS as ALL } from "@/hooks/use-group-filter";
import { useDateRange, rangeBoundsIso, todayStr } from "@/hooks/use-date-filter";
import { DateRangeFilter } from "@/components/DateFilter";

export default function Screenshots() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [groupFilter, setGroupFilter] = useGroupFilter();
  const [dateRange] = useDateRange();
  const { from, to } = useMemo(() => rangeBoundsIso(dateRange), [dateRange]);
  const isSingleDay = dateRange.from === dateRange.to;
  const { data: devices } = useListDevices();
  const groups = useMemo(() => {
    const set = new Set<string>();
    devices?.forEach((d) => set.add(d.deviceGroup));
    return Array.from(set).sort();
  }, [devices]);
  const params = {
    limit: 200,
    from,
    to,
    ...(flaggedOnly ? { flagged: true } : {}),
    ...(groupFilter !== ALL ? { group: groupFilter } : {}),
  };
  const { data: screenshots, isLoading } = useListScreenshots(params, {
    query: { queryKey: getListScreenshotsQueryKey(params) },
  });
  const flag = useFlagScreenshot();

  const toggleFlag = (id: string, current: boolean) => {
    flag.mutate(
      { id, data: { flagged: !current } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListScreenshotsQueryKey(params) });
          toast({ title: current ? "Flag removed" : "Screenshot flagged" });
        },
        onError: (error: any) => {
          toast({ title: "Failed to update flag", description: error.message, variant: "destructive" });
        },
      },
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Screenshots</h1>
          <p className="text-muted-foreground mt-1">
            {isSingleDay
              ? dateRange.to === todayStr()
                ? "Today's captures, taken with explicit user consent."
                : "Captures from the selected day, taken with explicit user consent."
              : "Captures from the selected range, taken with explicit user consent."}
          </p>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full sm:w-auto">
          <DateRangeFilter />
          <Select value={groupFilter} onValueChange={setGroupFilter}>
            <SelectTrigger className="w-full sm:w-44">
              <SelectValue placeholder="All groups" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All groups</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g} value={g}>
                  {g}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant={flaggedOnly ? "default" : "outline"}
            className="gap-2"
            onClick={() => setFlaggedOnly((v) => !v)}
          >
            <Flag className="h-4 w-4" />
            {flaggedOnly ? "Showing flagged" : "Flagged only"}
          </Button>
        </div>
      </div>

      <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 flex gap-3 text-sm text-primary">
        <Info className="h-5 w-5 flex-shrink-0 mt-0.5" />
        <p>
          <strong>Transparency Notice:</strong> All screenshots are captured only while monitoring is actively enabled,
          and users are notified via the system tray icon when captures occur.
        </p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 animate-pulse">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <div key={i} className="aspect-video bg-muted rounded-xl"></div>
          ))}
        </div>
      ) : screenshots?.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center h-64 text-muted-foreground">
            <ImageIcon className="h-10 w-10 mb-4 opacity-20" />
            <p>
              {flaggedOnly
                ? "No flagged screenshots in this range."
                : isSingleDay && dateRange.to === todayStr()
                  ? "No screenshots have been captured today yet."
                  : isSingleDay
                    ? "No screenshots were captured on this day."
                    : "No screenshots were captured in this range."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {screenshots?.map((screenshot, i) => (
            <div
              key={screenshot.id}
              className={`group rounded-xl overflow-hidden border bg-card shadow-sm hover:shadow-md transition-all ${
                screenshot.flagged ? "border-amber-500 ring-1 ring-amber-500/40" : "border-border"
              }`}
            >
              <button
                type="button"
                onClick={() => setViewerIndex(i)}
                aria-label={`View screenshot from ${format(new Date(screenshot.capturedAt), "PPpp")}`}
                className="block w-full cursor-pointer aspect-video bg-secondary relative overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <img
                  src={screenshot.imageUrl}
                  alt="Screenshot"
                  className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                  loading="lazy"
                />
                {screenshot.flagged && (
                  <div className="absolute top-2 left-2 bg-amber-500 text-white px-2 py-0.5 rounded-md text-xs font-medium flex items-center gap-1">
                    <Flag className="h-3 w-3" /> Flagged
                  </div>
                )}
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors"></div>
              </button>
              <div className="p-3 bg-card border-t border-border flex items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">{format(new Date(screenshot.capturedAt), "MMM d, yyyy")}</p>
                  <p className="text-xs text-muted-foreground mt-1">{format(new Date(screenshot.capturedAt), "h:mm:ss a")}</p>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className={`h-8 w-8 ${screenshot.flagged ? "text-amber-500" : "text-muted-foreground"}`}
                  title={screenshot.flagged ? "Remove flag" : "Flag screenshot"}
                  onClick={() => toggleFlag(screenshot.id, screenshot.flagged)}
                  disabled={flag.isPending}
                >
                  <Flag className={`h-4 w-4 ${screenshot.flagged ? "fill-current" : ""}`} />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ScreenshotLightbox
        screenshots={screenshots ?? []}
        index={viewerIndex ?? 0}
        onIndexChange={setViewerIndex}
        open={viewerIndex !== null}
        onOpenChange={(o) => {
          if (!o) setViewerIndex(null);
        }}
      />
    </div>
  );
}
