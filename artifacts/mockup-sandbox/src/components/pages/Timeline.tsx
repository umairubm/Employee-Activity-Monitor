import * as React from "react";
import { Clock, Monitor, MousePointer, Keyboard, Search, Filter, Camera } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useAppStore } from "../../store";

export default function Timeline() {
  const { devices, logs, selectedDeviceId, selectDevice } = useAppStore();
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState<"all" | "productive" | "idle" | "neutral">("all");

  const selectedDevice = devices.find((d) => d.id === selectedDeviceId) ?? devices[0];
  const deviceLogs = logs.filter((l) => l.deviceId === selectedDevice.id);

  const filtered = deviceLogs.filter((l) => {
    const matchSearch =
      l.processName.toLowerCase().includes(search.toLowerCase()) ||
      l.windowTitle.toLowerCase().includes(search.toLowerCase());
    const matchFilter = filter === "all" || l.type === filter;
    return matchSearch && matchFilter;
  });

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  };

  const typeColors: Record<string, string> = {
    productive: "bg-emerald-50 text-emerald-600 border-emerald-200",
    neutral: "bg-indigo-50 text-indigo-600 border-indigo-200",
    idle: "bg-amber-50 text-amber-600 border-amber-200",
    media: "bg-purple-50 text-purple-600 border-purple-200",
  };

  const dotColors: Record<string, string> = {
    productive: "bg-emerald-100 text-emerald-500",
    neutral: "bg-indigo-100 text-indigo-500",
    idle: "bg-amber-100 text-amber-500",
    media: "bg-purple-100 text-purple-500",
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            Activity Timeline
          </h1>
          <p className="text-slate-500 text-sm">
            Viewing: <span className="font-medium text-indigo-600">{selectedDevice.name}</span> — {selectedDevice.user}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white dark:bg-slate-800 dark:border-slate-700 text-slate-700 dark:text-slate-300"
            value={selectedDeviceId ?? ""}
            onChange={(e) => selectDevice(e.target.value)}
          >
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} — {d.user}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Filter Bar */}
      <Card className="border-none shadow-sm bg-white dark:bg-slate-800">
        <CardContent className="p-4 flex flex-col md:flex-row gap-4 items-center justify-between">
          <div className="relative w-full md:w-[280px]">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <Input
              placeholder="Search app or window..."
              className="pl-8"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex gap-2 items-center flex-wrap">
            {(["all", "productive", "idle", "neutral"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`text-xs px-3 py-1.5 rounded-full font-medium transition-all capitalize ${
                  filter === f
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Timeline */}
      <div className="space-y-3">
        {filtered.length === 0 && (
          <div className="text-center py-16 text-slate-400">
            <Clock className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p>No activity logs match your filter.</p>
          </div>
        )}
        {filtered.map((event, index) => (
          <div key={event.id} className="relative flex gap-4 items-start">
            {/* Connecting line */}
            {index !== filtered.length - 1 && (
              <div className="absolute left-6 top-12 bottom-0 w-0.5 bg-slate-100 dark:bg-slate-700" />
            )}

            {/* Icon dot */}
            <div className={`relative z-10 flex-shrink-0 w-12 h-12 rounded-full flex items-center justify-center ${dotColors[event.type]}`}>
              {event.type === "idle" ? <Clock className="h-5 w-5" /> : <Monitor className="h-5 w-5" />}
            </div>

            {/* Card */}
            <Card className="flex-1 border-none shadow-sm bg-white dark:bg-slate-800 hover:shadow-md transition-shadow">
              <CardContent className="p-4">
                <div className="flex flex-col md:flex-row justify-between gap-2">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold text-slate-900 dark:text-white text-sm">
                        {event.processName}
                      </h3>
                      <Badge variant="outline" className={`text-xs ${typeColors[event.type]}`}>
                        {event.category}
                      </Badge>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 truncate max-w-md">
                      {event.windowTitle}
                    </p>
                  </div>
                  <div className="flex md:flex-col items-start md:items-end justify-between text-xs text-slate-500 gap-1 flex-shrink-0">
                    <span className="font-medium text-slate-700 dark:text-slate-300">{event.startedAt}</span>
                    <span>{formatDuration(event.durationSeconds)}</span>
                  </div>
                </div>

                {event.type === "productive" && (
                  <div className="mt-3 pt-3 border-t border-slate-50 dark:border-slate-700 flex gap-4 text-xs text-slate-400">
                    <span className="flex items-center gap-1">
                      <MousePointer className="h-3 w-3" /> Active input
                    </span>
                    <span className="flex items-center gap-1">
                      <Keyboard className="h-3 w-3" /> 45 WPM avg
                    </span>
                  </div>
                )}

                {event.type === "idle" && (
                  <div className="mt-3 pt-3 border-t border-slate-50 dark:border-slate-700">
                    <p className="text-xs text-amber-500">
                      ⚠ No input detected for {Math.floor(event.durationSeconds / 60)} minutes
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        ))}
      </div>
    </div>
  );
}
