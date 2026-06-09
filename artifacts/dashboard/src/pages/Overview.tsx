import React, { useMemo, useState } from "react";
import {
  useGetSummary,
  getGetSummaryQueryKey,
  useGetLeaderboard,
  getGetLeaderboardQueryKey,
  useListDevices,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { MonitorSmartphone, Image as ImageIcon, Terminal, Users, Activity, Trophy } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Link } from "wouter";

const ALL = "__all__";

export default function Overview() {
  const [groupFilter, setGroupFilter] = useState<string>(ALL);
  const { data: devices } = useListDevices();
  const groups = useMemo(() => {
    const set = new Set<string>();
    devices?.forEach((d) => set.add(d.deviceGroup));
    return Array.from(set).sort();
  }, [devices]);

  const params = groupFilter !== ALL ? { group: groupFilter } : {};
  const { data: summary, isLoading: isSummaryLoading } = useGetSummary(params, {
    query: { queryKey: getGetSummaryQueryKey(params) },
  });
  const { data: leaderboard, isLoading: isLeaderboardLoading } = useGetLeaderboard(params, {
    query: { queryKey: getGetLeaderboardQueryKey(params) },
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

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
          <p className="text-muted-foreground mt-1">Today's workforce activity and IT status.</p>
        </div>
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Today's Activity Breakdown
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
            <CardDescription>Most productive devices today.</CardDescription>
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
                <p className="text-sm text-muted-foreground">No data available for today yet.</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
