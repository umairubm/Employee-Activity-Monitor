import * as React from "react";
import { Camera, Flag, Download, Eye, X, Search, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useAppStore } from "../../store";
import type { Screenshot } from "../../store";
import { screenshotsApi } from "../../lib/api";


const getImageType = (dataUrl: string | undefined) => {
  const match = dataUrl?.match(/^data:image\/([a-zA-Z0-9]+);/);
  return match ? match[1].toUpperCase() : "JPEG";
};

export default function Screenshots() {
  const { devices } = useAppStore();
  const [screenshots, setScreenshots] = React.useState<Screenshot[]>([]);
  const [search, setSearch] = React.useState("");
  const [deviceFilter, setDeviceFilter] = React.useState<string>("all");
  const [groupFilter, setGroupFilter] = React.useState<string>("all");
  const [showFlaggedOnly, setShowFlaggedOnly] = React.useState(false);
  const [lightbox, setLightbox] = React.useState<string | null>(null);

  React.useEffect(() => {
    screenshotsApi.list().then(setScreenshots).catch(console.error);
  }, []);

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

  const filtered = screenshots.filter((s) => {
    const parentDevice = devices.find((d) => d.id === s.deviceId);
    const parentGroup = parentDevice?.deviceGroup || "Unassigned";

    const matchSearch =
      s.deviceName.toLowerCase().includes(search.toLowerCase()) ||
      s.userName.toLowerCase().includes(search.toLowerCase());
    const matchDevice = deviceFilter === "all" || s.deviceId === deviceFilter;
    const matchGroup = groupFilter === "all" || parentGroup === groupFilter;
    const matchFlagged = !showFlaggedOnly || s.flagged;
    return matchSearch && matchDevice && matchGroup && matchFlagged;
  });

  const flaggedCount = screenshots.filter((s) => s.flagged).length;
  const lightboxShot = lightbox ? screenshots.find((s) => s.id === lightbox) : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            Screenshots
          </h1>
          <p className="text-slate-500 text-sm">
            {screenshots.length} captures · {flaggedCount} flagged
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
            {filtered.length} of {screenshots.length} shown
          </span>
        </CardContent>
      </Card>

      {/* Grid */}
      {filtered.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <Camera className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p>No screenshots match your filter.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((shot) => (
            <Card
              key={shot.id}
              className={`border-none shadow-sm overflow-hidden group cursor-pointer transition-all hover:shadow-lg hover:-translate-y-0.5 ${
                shot.flagged ? "ring-2 ring-red-400 ring-offset-1" : ""
              }`}
              onClick={() => setLightbox(shot.id)}
            >
              {/* Thumbnail */}
              <div className="relative overflow-hidden aspect-video bg-slate-900">
                <img
                  src={shot.thumbnail}
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

      {/* Lightbox */}
      {lightboxShot && (
        <div
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
          onClick={() => setLightbox(null)}
        >
          <div
            className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl max-w-3xl w-full overflow-hidden"
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
                  className="text-slate-400 hover:text-slate-700 transition-colors"
                  onClick={() => setLightbox(null)}
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            <img
              src={lightboxShot.thumbnail}
              alt="Screenshot"
              className="w-full object-contain max-h-[60vh]"
            />
            <div className="p-4 flex justify-between items-center">
              <span className="text-xs text-slate-500 flex items-center">
                <span className="font-medium bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded mr-2">
                  {getImageType(lightboxShot.thumbnail)}
                </span>
                {lightboxShot.fileSizeKb} KB
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
