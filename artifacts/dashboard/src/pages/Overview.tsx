import React, { useMemo, useState } from "react";
import {
  useGetSummary,
  getGetSummaryQueryKey,
  useGetLeaderboard,
  getGetLeaderboardQueryKey,
  useGetGroupComparison,
  getGetGroupComparisonQueryKey,
  useListDevices,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { MonitorSmartphone, Image as ImageIcon, Terminal, Users, Activity, Trophy, LayoutGrid, Download } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Link } from "wouter";
import { useGroupFilter, ALL_GROUPS as ALL } from "@/hooks/use-group-filter";

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function downloadCsv(filename: string, rows: (string | number)[][]) {
  const escape = (v: string | number) => {
    let s = String(v);
    // Guard against CSV formula injection: prefix cells that a spreadsheet
    // would otherwise evaluate as a formula with a single quote.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = rows.map((r) => r.map(escape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function Overview() {
  const { toast } = useToast();
  const [groupFilter, setGroupFilter] = useGroupFilter();
  const [rangeFrom, setRangeFrom] = useState(todayStr());
  const [rangeTo, setRangeTo] = useState(todayStr());
  const isToday = rangeFrom === todayStr() && rangeTo === todayStr();
  const { data: devices } = useListDevices();
  const groups = useMemo(() => {
    const set = new Set<string>();
    devices?.forEach((d) => set.add(d.deviceGroup));
    return Array.from(set).sort();
  }, [devices]);

  const rangeParams = { from: rangeFrom, to: rangeTo };
  const params = {
    ...(groupFilter !== ALL ? { group: groupFilter } : {}),
    ...rangeParams,
  };
  const { data: summary, isLoading: isSummaryLoading } = useGetSummary(params, {
    query: { queryKey: getGetSummaryQueryKey(params) },
  });
  const { data: leaderboard, isLoading: isLeaderboardLoading } = useGetLeaderboard(params, {
    query: { queryKey: getGetLeaderboardQueryKey(params) },
  });
  const { data: groupComparison } = useGetGroupComparison(rangeParams, {
    query: { queryKey: getGetGroupComparisonQueryKey(rangeParams) },
  });

  if (isSummaryLoading || isLeaderboardLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 bg-muted rounded-md mb-6"></div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="h-32 bg-muted rounded-xl"></div>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 h-96 bg-muted rounded-xl"></div>
          <div className="h-96 bg-muted rounded-xl"></div>
        </div>
      </div>
    );
  }

  if (!summary) return null;

  const totalActivity = summary.activityToday.totalSeconds || 1; // Prevent division by zero
  const productivePct = (summary.activityToday.productiveSeconds / totalActivity) * 100;
  const unproductivePct = (summary.activityToday.unproductiveSeconds / totalActivity) * 100;
  const neutralPct = (summary.activityToday.neutralSeconds / totalActivity) * 100;
  
  const formatHours = (seconds: number) => {
    const hours = seconds / 3600;
    return hours.toFixed(1) + 'h';
  };

  const exportCsv = () => {
    const scope = groupFilter !== ALL ? groupFilter : "all-groups";
    const rows: (string | number)[][] = [
      ["Group", groupFilter !== ALL ? groupFilter : "All groups"],
      ["From", rangeFrom],
      ["To", rangeTo],
      [],
      ["Activity breakdown"],
      ["Classification", "Hours"],
      ["Productive", (summary.activityToday.productiveSeconds / 3600).toFixed(2)],
      ["Neutral", (summary.activityToday.neutralSeconds / 3600).toFixed(2)],
      ["Unproductive", (summary.activityToday.unproductiveSeconds / 3600).toFixed(2)],
      ["Undefined", (summary.activityToday.undefinedSeconds / 3600).toFixed(2)],
      ["Total", (summary.activityToday.totalSeconds / 3600).toFixed(2)],
      [],
      ["Leaderboard"],
      ["Rank", "Device", "Productive (hours)", "Total (hours)", "Score"],
      ...(leaderboard ?? []).map((item, index) => [
        index + 1,
        item.systemName,
        (item.productiveSeconds / 3600).toFixed(2),
        (item.totalSeconds / 3600).toFixed(2),
        Math.round(item.score),
      ]),
    ];
    downloadCsv(`overview_${scope}_${rangeFrom}_to_${rangeTo}.csv`, rows);
    toast({ title: "CSV exported" });
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
          <p className="text-muted-foreground mt-1">
            {isToday
              ? "Today's workforce activity and IT status."
              : "Workforce activity and IT status over the selected range."}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
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
          <div className="flex gap-1">
            {[
              { label: "Today", from: todayStr(), to: todayStr() },
              { label: "7d", from: daysAgoStr(6), to: todayStr() },
              { label: "30d", from: daysAgoStr(29), to: todayStr() },
            ].map((preset) => {
              const active = rangeFrom === preset.from && rangeTo === preset.to;
              return (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => {
                    setRangeFrom(preset.from);
                    setRangeTo(preset.to);
                  }}
                  className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "bg-background hover:bg-muted"
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
          <div className="flex flex-col">
            <Label htmlFor="range-from" className="text-xs text-muted-foreground mb-1 block">From</Label>
            <Input
              id="range-from"
              type="date"
              className="h-8 w-[9.5rem]"
              value={rangeFrom}
              max={rangeTo}
              onChange={(e) => setRangeFrom(e.target.value || todayStr())}
            />
          </div>
          <div className="flex flex-col">
            <Label htmlFor="range-to" className="text-xs text-muted-foreground mb-1 block">To</Label>
            <Input
              id="range-to"
              type="date"
              className="h-8 w-[9.5rem]"
              value={rangeTo}
              min={rangeFrom}
              max={todayStr()}
              onChange={(e) => setRangeTo(e.target.value || todayStr())}
            />
          </div>
          <Button
            variant="outline"
            className="h-8 gap-2"
            onClick={exportCsv}
            disabled={!leaderboard || leaderboard.length === 0}
          >
            <Download className="h-4 w-4" /> Export
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Enrolled Devices</CardTitle>
            <MonitorSmartphone className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary.devices.total}</div>
            <p className="text-xs text-muted-foreground mt-1">
              <span className="text-emerald-600 font-medium">{summary.devices.online} online</span> right now
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Active Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary.usersCount}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Monitored with consent
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Screenshots Today</CardTitle>
            <ImageIcon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary.screenshotsToday}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Across all active devices
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Pending Commands</CardTitle>
            <Terminal className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{summary.pendingCommands}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Awaiting device acknowledgement
            </p>
          </CardContent>
        </Card>
      </div>

      {groupComparison && groupComparison.length > 0 && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <LayoutGrid className="h-5 w-5" />
                Team Comparison
              </CardTitle>
              <CardDescription>Productivity across all device groups over the selected range, side by side.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {groupComparison.map((g) => (
                <div
                  key={g.group}
                  className="rounded-xl border bg-card p-4 flex flex-col gap-3"
                >
                  <div className="flex items-center justify-between">
                    <div className="font-semibold truncate" title={g.group}>{g.group}</div>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {g.deviceCount} {g.deviceCount === 1 ? "device" : "devices"}
                    </span>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-3xl font-bold text-primary">{g.score}</span>
                    <span className="text-sm text-muted-foreground">/ 100 score</span>
                  </div>
                  <Progress value={g.score} className="h-2" />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{formatHours(g.productiveSeconds)} productive</span>
                    <span>{formatHours(g.totalSeconds)} tracked</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              {isToday ? "Today's Activity Breakdown" : "Activity Breakdown"}
            </CardTitle>
            <CardDescription>Aggregate foreground app usage classified by productivity.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-6 mt-4">
              <div className="h-4 flex rounded-full overflow-hidden bg-secondary">
                <div style={{ width: `${productivePct}%` }} className="bg-primary transition-all duration-1000" title="Productive"></div>
                <div style={{ width: `${neutralPct}%` }} className="bg-slate-400 transition-all duration-1000" title="Neutral"></div>
                <div style={{ width: `${unproductivePct}%` }} className="bg-destructive transition-all duration-1000" title="Unproductive"></div>
              </div>
              
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-3 h-3 rounded-full bg-primary"></div>
                    <span className="text-sm font-medium">Productive</span>
                  </div>
                  <div className="text-2xl font-bold">{formatHours(summary.activityToday.productiveSeconds)}</div>
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-3 h-3 rounded-full bg-slate-400"></div>
                    <span className="text-sm font-medium">Neutral</span>
                  </div>
                  <div className="text-2xl font-bold">{formatHours(summary.activityToday.neutralSeconds)}</div>
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-3 h-3 rounded-full bg-destructive"></div>
                    <span className="text-sm font-medium">Unproductive</span>
                  </div>
                  <div className="text-2xl font-bold">{formatHours(summary.activityToday.unproductiveSeconds)}</div>
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-3 h-3 rounded-full bg-secondary border border-border"></div>
                    <span className="text-sm font-medium">Undefined</span>
                  </div>
                  <div className="text-2xl font-bold">{formatHours(summary.activityToday.undefinedSeconds)}</div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Trophy className="h-5 w-5 text-amber-500" />
              Leaderboard
            </CardTitle>
            <CardDescription>{isToday ? "Most productive devices today." : "Most productive devices over the selected range."}</CardDescription>
          </CardHeader>
          <CardContent>
            {leaderboard && leaderboard.length > 0 ? (
              <div className="space-y-4">
                {leaderboard.map((item, index) => (
                  <div key={item.deviceId} className="flex items-center justify-between group">
                    <div className="flex items-center gap-3">
                      <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                        index === 0 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-500' :
                        index === 1 ? 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-400' :
                        index === 2 ? 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-500' :
                        'bg-secondary text-muted-foreground'
                      }`}>
                        {index + 1}
                      </div>
                      <div>
                        <Link href={`/devices/${item.deviceId}`} className="text-sm font-medium hover:underline">
                          {item.systemName}
                        </Link>
                        <div className="text-xs text-muted-foreground">{formatHours(item.productiveSeconds)} productive</div>
                      </div>
                    </div>
                    <div className="text-sm font-bold text-primary">
                      {Math.round(item.score)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <Trophy className="h-10 w-10 text-muted mb-3" />
                <p className="text-sm text-muted-foreground">{isToday ? "No data available for today yet." : "No data available for the selected range."}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
