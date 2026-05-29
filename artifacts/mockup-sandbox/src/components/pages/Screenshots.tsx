import * as React from "react";
import { Camera, Flag, Download, Eye, X, Search, AlertTriangle, ChevronLeft, ChevronRight, RotateCcw, Shield, ChevronsLeft, ChevronsRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useAppStore } from "../../store";
import type { Screenshot } from "../../store";
import { screenshotsApi } from "../../lib/api";

const ITEMS_PER_PAGE = 100;

const getImageType = (dataUrl: string | undefined) => {
  const match = dataUrl?.match(/^data:image\/([a-zA-Z0-9]+);/);
  return match ? match[1].toUpperCase() : "JPEG";
};

// ── Lazy Image Component ──────────────────────────────────────────────────────
// Uses IntersectionObserver to only load the actual image when it scrolls into view.
// Shows a subtle shimmer placeholder until visible, then fades in the real image.
function LazyImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const imgRef = React.useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = React.useState(false);
  const [isLoaded, setIsLoaded] = React.useState(false);

  React.useEffect(() => {
    const el = imgRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.unobserve(el);
        }
      },
      { rootMargin: "200px" } // Start loading 200px before it enters viewport
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={imgRef} className="relative w-full h-full">
      {/* Shimmer placeholder */}
      {!isLoaded && (
        <div className="absolute inset-0 bg-gradient-to-r from-slate-200 via-slate-100 to-slate-200 dark:from-slate-800 dark:via-slate-700 dark:to-slate-800 animate-pulse" />
      )}
      {isVisible && (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          onLoad={() => setIsLoaded(true)}
          className={`${className || ""} transition-opacity duration-500 ${isLoaded ? "opacity-100" : "opacity-0"}`}
        />
      )}
    </div>
  );
}

export default function Screenshots() {
  const { devices } = useAppStore();
  const [screenshots, setScreenshots] = React.useState<Screenshot[]>([]);
  const [search, setSearch] = React.useState("");
  const [deviceFilter, setDeviceFilter] = React.useState<string>("all");
  const [groupFilter, setGroupFilter] = React.useState<string>("all");
  const [showFlaggedOnly, setShowFlaggedOnly] = React.useState(false);
  const [lightbox, setLightbox] = React.useState<string | null>(null);

  const [loading, setLoading] = React.useState(false);
  const [currentPage, setCurrentPage] = React.useState(1);
  const [serverTotalPages, setServerTotalPages] = React.useState<number | null>(null);
  const [serverTotalItems, setServerTotalItems] = React.useState<number | null>(null);

  const fetchScreenshots = React.useCallback(async (page = 1) => {
    setLoading(true);
    try {
      const result = await screenshotsApi.list({
        page,
        limit: ITEMS_PER_PAGE,
        deviceId: deviceFilter !== "all" ? deviceFilter : undefined,
      });

      // Handle paginated envelope response
      if (result && result.data && Array.isArray(result.data)) {
        setScreenshots(result.data);
        setServerTotalPages(result.totalPages || 1);
        setServerTotalItems(result.total || result.data.length);
        setCurrentPage(result.page || page);
      } else if (Array.isArray(result)) {
        // Legacy flat array fallback
        setScreenshots(result);
        setServerTotalPages(null);
        setServerTotalItems(null);
        if (page === 1) setCurrentPage(1);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [deviceFilter]);

  React.useEffect(() => {
    fetchScreenshots(1);
    setCurrentPage(1);
  }, [deviceFilter]);

  // When page changes, re-fetch or paginate locally
  const goToPage = (page: number, currentTotalPages: number) => {
    if (page < 1 || page > currentTotalPages || page === currentPage) return;
    window.scrollTo({ top: 0, behavior: "smooth" });
    setCurrentPage(page);
    if (serverTotalPages !== null) {
      fetchScreenshots(page);
    }
  };

  const toggleFlag = async (screenshotId: string) => {
    try {
      const updated = await screenshotsApi.flag(screenshotId);
      setScreenshots((prev) => prev.map((s) => (s.id === screenshotId ? updated : s)));
    } catch {
      setScreenshots((prev) =>
        prev.map((s) => (s.id === screenshotId ? { ...s, flagged: !s.flagged } : s))
      );
    }
  };

  const allGroups = React.useMemo(() => Array.from(new Set(devices.map(d => d.deviceGroup || "Unassigned"))).sort(), [devices]);

  // Client-side filtering on current page data
  const filtered = screenshots.filter((s) => {
    const parentDevice = devices.find((d) => d.id === s.deviceId);
    const parentGroup = parentDevice?.deviceGroup || "Unassigned";

    const matchSearch =
      s.deviceName.toLowerCase().includes(search.toLowerCase()) ||
      s.userName.toLowerCase().includes(search.toLowerCase());
    const matchGroup = groupFilter === "all" || parentGroup === groupFilter;
    const matchFlagged = !showFlaggedOnly || s.flagged;
    return matchSearch && matchGroup && matchFlagged;
  });

  // Ensure currentPage doesn't exceed newly computed totalPages if filter shrinks
  const totalPages = serverTotalPages !== null ? serverTotalPages : Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE));
  const totalItems = serverTotalItems !== null ? serverTotalItems : filtered.length;

  React.useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(1);
  }, [totalPages, currentPage]);

  const displayedFiltered = serverTotalPages !== null 
    ? filtered 
    : filtered.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

  const flaggedCount = screenshots.filter((s) => s.flagged).length;
  const lightboxShot = lightbox ? screenshots.find((s) => s.id === lightbox) : null;

  const handleKeyDown = (e: KeyboardEvent) => {
    const currentIndex = displayedFiltered.findIndex((s) => s.id === lightbox);
    if (currentIndex !== -1) {
      if (e.key === "ArrowRight") {
        const nextIndex = (currentIndex + 1) % displayedFiltered.length;
        setLightbox(displayedFiltered[nextIndex].id);
      } else if (e.key === "ArrowLeft") {
        const prevIndex = (currentIndex - 1 + displayedFiltered.length) % displayedFiltered.length;
        setLightbox(displayedFiltered[prevIndex].id);
      } else if (e.key === "Escape") {
        setLightbox(null);
      }
    }
  };

  React.useEffect(() => {
    if (lightbox) {
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [lightbox, displayedFiltered]);

  const navigate = (dir: "prev" | "next") => {
    const currentIndex = displayedFiltered.findIndex((s) => s.id === lightbox);
    if (currentIndex === -1) return;
    if (dir === "next") {
      const nextIndex = (currentIndex + 1) % displayedFiltered.length;
      setLightbox(displayedFiltered[nextIndex].id);
    } else {
      const prevIndex = (currentIndex - 1 + displayedFiltered.length) % displayedFiltered.length;
      setLightbox(displayedFiltered[prevIndex].id);
    }
  };

  // Generate page numbers to show (smart windowing)
  const getPageNumbers = () => {
    const pages: (number | "...")[] = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (currentPage > 3) pages.push("...");
      for (let i = Math.max(2, currentPage - 1); i <= Math.min(totalPages - 1, currentPage + 1); i++) {
        pages.push(i);
      }
      if (currentPage < totalPages - 2) pages.push("...");
      pages.push(totalPages);
    }
    return pages;
  };

  const startItem = (currentPage - 1) * ITEMS_PER_PAGE + 1;
  const endItem = Math.min(currentPage * ITEMS_PER_PAGE, totalItems);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            Screenshots
          </h1>
          <p className="text-slate-500 text-sm">
            {totalItems} total captures · Page {currentPage} of {totalPages}
          </p>
        </div>
        {flaggedCount > 0 && (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            <AlertTriangle className="h-4 w-4 text-red-500" />
            <span className="text-sm text-red-700 font-medium">{flaggedCount} suspicious captures</span>
          </div>
        )}
      </div>

      {/* Filter Bar */}
      <Card className="border-none shadow-sm bg-white dark:bg-slate-800">
        <CardContent className="p-4 flex flex-col md:flex-row gap-3 items-center">
          <div className="relative w-full md:w-[250px]">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <Input
              placeholder="Search device or user..."
              className="pl-8"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className="text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white dark:bg-slate-800 dark:border-slate-700 text-slate-700 dark:text-slate-300"
            value={deviceFilter}
            onChange={(e) => setDeviceFilter(e.target.value)}
          >
            <option value="all">All Devices</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          <select
            className="text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white dark:bg-slate-800 dark:border-slate-700 text-slate-700 dark:text-slate-300"
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
          >
            <option value="all">All Groups</option>
            {allGroups.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
          <button
            onClick={() => fetchScreenshots(currentPage)}
            disabled={loading}
            className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg font-medium transition-all bg-slate-100 text-slate-600 hover:bg-slate-200 ${loading ? 'opacity-50' : ''}`}
          >
            <RotateCcw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={() => setShowFlaggedOnly(!showFlaggedOnly)}
            className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg font-medium transition-all ${
              showFlaggedOnly
                ? "bg-red-600 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            <Flag className="h-3.5 w-3.5" />
            Flagged Only
          </button>
          <span className="text-xs text-slate-400 ml-auto">
            {displayedFiltered.length} of {totalItems} shown (page {currentPage})
          </span>
        </CardContent>
      </Card>

      {/* Grid */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-32 space-y-5">
          <div className="w-20 h-20 bg-indigo-600 rounded-2xl flex items-center justify-center animate-pulse shadow-xl shadow-indigo-600/20">
            <Shield className="h-10 w-10 text-white" strokeWidth={2.5} />
          </div>
          <p className="text-slate-500 font-medium animate-pulse">Loading secure captures...</p>
        </div>
      ) : displayedFiltered.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <Camera className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p>No screenshots match your filter.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {displayedFiltered.map((shot) => (
            <Card
              key={shot.id}
              className={`border-none shadow-sm overflow-hidden group cursor-pointer transition-all hover:shadow-lg hover:-translate-y-0.5 ${
                shot.flagged ? "ring-2 ring-red-400 ring-offset-1" : ""
              }`}
              onClick={() => setLightbox(shot.id)}
            >
              {/* Thumbnail with lazy loading */}
              <div className="relative overflow-hidden aspect-video bg-slate-900">
                <LazyImage
                  src={shot.thumbnail || ""}
                  alt={`Screenshot by ${shot.userName}`}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                />
                {shot.flagged && (
                  <div className="absolute top-2 right-2">
                    <span className="flex items-center gap-1 bg-red-500 text-white text-[10px] font-medium px-1.5 py-0.5 rounded-full">
                      <Flag className="h-2.5 w-2.5" /> Flagged
                    </span>
                  </div>
                )}
                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                  <button
                    className="bg-white text-slate-900 text-xs px-3 py-1.5 rounded-lg font-medium hover:bg-slate-100 transition-colors"
                    onClick={(e) => { e.stopPropagation(); setLightbox(shot.id); }}
                  >
                    <Eye className="h-3.5 w-3.5 inline mr-1" /> View
                  </button>
                  <button
                    className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
                      shot.flagged
                        ? "bg-red-500 text-white hover:bg-red-600"
                        : "bg-amber-400 text-slate-900 hover:bg-amber-500"
                    }`}
                    onClick={(e) => { e.stopPropagation(); toggleFlag(shot.id); }}
                  >
                    <Flag className="h-3.5 w-3.5 inline mr-1" />
                    {shot.flagged ? "Unflag" : "Flag"}
                  </button>
                </div>
              </div>

              {/* Meta */}
              <CardContent className="p-3 bg-white dark:bg-slate-800">
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-900 dark:text-white truncate">{shot.deviceName}</p>
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 mt-0.5">
                      <p className="text-[11px] font-medium text-slate-500 truncate">{shot.userName}</p>
                      <span className="w-1 h-1 rounded-full bg-slate-300 dark:bg-slate-700" />
                      <p className="text-[10px] font-bold text-slate-400">
                        {new Date(shot.capturedAt).toLocaleDateString()}
                      </p>
                      <span className="w-1 h-1 rounded-full bg-slate-300 dark:bg-slate-700" />
                      <p className="text-[10px] font-bold text-indigo-600 dark:text-indigo-400">
                        {new Date(shot.capturedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })}
                      </p>
                    </div>
                  </div>
                  <span className="text-xs text-slate-400 flex-shrink-0 ml-2 text-right">
                    <span className="font-medium bg-slate-100 dark:bg-slate-700 px-1.5 py-0.5 rounded mr-1">
                      {getImageType(shot.thumbnail)}
                    </span>
                    {shot.fileSizeKb} KB
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ── Pagination Controls ───────────────────────────────────────────────── */}
      {totalPages > 1 && !loading && (
        <div className="sticky bottom-0 z-10 flex flex-col sm:flex-row items-center justify-between gap-4 py-4 mt-auto bg-slate-50 dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800">
          {/* Item range indicator */}
          <p className="text-xs font-medium text-slate-400">
            Showing <span className="text-slate-600 dark:text-slate-300 font-bold">{startItem}–{endItem}</span> of{" "}
            <span className="text-slate-600 dark:text-slate-300 font-bold">{totalItems}</span> captures
          </p>

          {/* Page buttons */}
          <div className="flex items-center gap-1">
            {/* First page */}
            <button
              onClick={() => goToPage(1, totalPages)}
              disabled={currentPage === 1}
              className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
              title="First page"
            >
              <ChevronsLeft className="h-4 w-4" />
            </button>
            {/* Previous */}
            <button
              onClick={() => goToPage(currentPage - 1, totalPages)}
              disabled={currentPage === 1}
              className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
              title="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>

            {/* Page numbers */}
            {getPageNumbers().map((page, i) =>
              page === "..." ? (
                <span key={`ellipsis-${i}`} className="px-2 text-slate-400 text-sm select-none">…</span>
              ) : (
                <button
                  key={page}
                  onClick={() => goToPage(page as number, totalPages)}
                  className={`min-w-[36px] h-9 rounded-lg text-sm font-bold transition-all ${
                    page === currentPage
                      ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/20"
                      : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white"
                  }`}
                >
                  {page}
                </button>
              )
            )}

            {/* Next */}
            <button
              onClick={() => goToPage(currentPage + 1, totalPages)}
              disabled={currentPage === totalPages}
              className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
              title="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            {/* Last page */}
            <button
              onClick={() => goToPage(totalPages, totalPages)}
              disabled={currentPage === totalPages}
              className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
              title="Last page"
            >
              <ChevronsRight className="h-4 w-4" />
            </button>
          </div>

          {/* Per-page info */}
          <p className="text-xs text-slate-400">
            <span className="font-bold text-indigo-500">{ITEMS_PER_PAGE}</span> per page
          </p>
        </div>
      )}

      {/* Lightbox */}
      {lightboxShot && (
        <div
          className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
          onClick={() => setLightbox(null)}
        >
          {/* Navigation Buttons */}
          <button 
            className="absolute left-4 md:left-10 top-1/2 -translate-y-1/2 bg-white/20 hover:bg-white/40 p-4 rounded-full text-white transition-all z-50 backdrop-blur-md shadow-2xl border border-white/20 group"
            onClick={(e) => { e.stopPropagation(); navigate("prev"); }}
            title="Previous (Left Arrow)"
          >
            <ChevronLeft className="h-8 w-8 group-hover:-translate-x-1 transition-transform" />
          </button>
          
          <button 
            className="absolute right-4 md:right-10 top-1/2 -translate-y-1/2 bg-white/20 hover:bg-white/40 p-4 rounded-full text-white transition-all z-50 backdrop-blur-md shadow-2xl border border-white/20 group"
            onClick={(e) => { e.stopPropagation(); navigate("next"); }}
            title="Next (Right Arrow)"
          >
            <ChevronRight className="h-8 w-8 group-hover:translate-x-1 transition-transform" />
          </button>

          <div
            className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl max-w-4xl w-full overflow-hidden relative"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-slate-100 dark:border-slate-800">
              <div>
                <h3 className="font-semibold text-slate-900 dark:text-white">{lightboxShot.deviceName}</h3>
                <p className="text-xs text-slate-500">{lightboxShot.userName} · {new Date(lightboxShot.capturedAt).toLocaleString()}</p>
              </div>
              <div className="flex items-center gap-2">
                {lightboxShot.flagged && (
                  <Badge className="bg-red-100 text-red-700 border-red-200 text-xs">Flagged</Badge>
                )}
                <button
                  className="p-2 text-slate-400 hover:text-slate-700 transition-colors"
                  onClick={() => setLightbox(null)}
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            <div className="bg-slate-950 flex items-center justify-center min-h-[300px]">
              <img
                src={lightboxShot.thumbnail}
                alt="Screenshot"
                className="w-full object-contain max-h-[75vh]"
              />
            </div>
            <div className="p-4 flex justify-between items-center bg-slate-50 dark:bg-slate-900/50">
              <span className="text-xs text-slate-500 flex items-center">
                <span className="font-medium bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded mr-2">
                  {getImageType(lightboxShot.thumbnail)}
                </span>
                {lightboxShot.fileSizeKb} KB
                <span className="ml-4 opacity-50">Keyboard: ← Prev | Next →</span>
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => toggleFlag(lightboxShot.id)}
                  className={lightboxShot.flagged ? "text-red-600 border-red-200 hover:bg-red-50" : ""}
                >
                  <Flag className="h-3.5 w-3.5 mr-1.5" />
                  {lightboxShot.flagged ? "Unflag" : "Flag"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
