import React, { useMemo, useState } from "react";
import {
  useGetTimesheet,
  getGetTimesheetQueryKey,
  useListDevices,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent, type ChartConfig } from "@/components/ui/chart";
import { CartesianGrid, XAxis, YAxis, Bar, BarChart } from "recharts";
import { Clock, Download, CalendarClock, TimerOff, LogOut } from "lucide-react";
import { useGroupFilter, ALL_GROUPS as ALL } from "@/hooks/use-group-filter";
import { useDateRange, daysAgoStr } from "@/hooks/use-date-filter";

function fmtHours(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

const CHART_CONFIG = {
  workedHours: { label: "Worked", color: "hsl(var(--chart-1))" },
  productiveHours: { label: "Productive", color: "hsl(var(--chart-2))" },
  idleHours: { label: "Idle", color: "hsl(var(--chart-4))" },
} satisfies ChartConfig;

function downloadCsv(filename: string, rows: (string | number)[][]) {
  const escape = (v: string | number) => {
    const s = String(v);
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

export default function Timesheets() {
  const [{ from, to }, setRange] = useDateRange();
  const [bucket, setBucket] = useState<"week" | "month">("week");
  const [groupFilter, setGroupFilter] = useGroupFilter();
  const [selectedDeviceId, setSelectedDeviceId] = useState("all");
  const { data: allDevices } = useListDevices();

  const groups = useMemo(() => {
    const set = new Set<string>();
    allDevices?.forEach((d) => set.add(d.deviceGroup));
    return Array.from(set).sort();
  }, [allDevices]);

  React.useEffect(() => {
    setSelectedDeviceId("all");
  }, [groupFilter]);

  const valid = from <= to;
  const params = {
    from,
    to,
    bucket,
    ...(groupFilter !== ALL ? { group: groupFilter } : {}),
  };
  const { data: report, isLoading, isError, error } = useGetTimesheet(params, {
    query: { queryKey: getGetTimesheetQueryKey(params), enabled: valid },
  });

  const devices = report?.devices ?? [];
  const singleDevice = selectedDeviceId !== "all";

  const totals = useMemo(() => {
    const t = {
      worked: 0,
      active: 0,
      idle: 0,
      productive: 0,
      lateDays: 0,
      earlyLeaveDays: 0,
    };
    for (const d of devices) {
      t.worked += d.totalWorkedSeconds;
      t.active += d.totalActiveSeconds;
      t.idle += d.totalIdleSeconds;
      t.productive += d.totalProductiveSeconds;
      t.lateDays += d.lateDays;
      t.earlyLeaveDays += d.earlyLeaveDays;
    }
    return t;
  }, [devices]);

  // Bucketed chart data: either aggregated across all devices, or one device.
  const chartData = useMemo(() => {
    const acc = new Map<
      string,
      { label: string; worked: number; productive: number; idle: number }
    >();
    const source = singleDevice
      ? devices.filter((d) => d.deviceId === selectedDeviceId)
      : devices;
    for (const d of source) {
      for (const b of d.buckets) {
        const cur = acc.get(b.key) ?? {
          label: b.label,
          worked: 0,
          productive: 0,
          idle: 0,
        };
        cur.worked += b.workedSeconds;
        cur.productive += b.productiveSeconds;
        cur.idle += b.idleSeconds;
        acc.set(b.key, cur);
      }
    }
    return Array.from(acc.entries())
      .sort((a, c) => (a[0] < c[0] ? -1 : a[0] > c[0] ? 1 : 0))
      .map(([, v]) => ({
        label: v.label,
        workedHours: Number((v.worked / 3600).toFixed(2)),
        productiveHours: Number((v.productive / 3600).toFixed(2)),
        idleHours: Number((v.idle / 3600).toFixed(2)),
      }));
  }, [devices, singleDevice, selectedDeviceId]);

  const exportCsv = () => {
    if (!report) return;
    const header = [
      "Device",
      "Group",
      "Period",
      "Worked (hours)",
      "Active (hours)",
      "Idle (hours)",
      "Productive (hours)",
      "Working days",
      "Present days",
      "Late days",
      "Early-leave days",
    ];
    const body: (string | number)[][] = [];
    for (const d of devices) {
      for (const b of d.buckets) {
        body.push([
          d.systemName,
          d.deviceGroup,
          b.label,
          (b.workedSeconds / 3600).toFixed(2),
          (b.activeSeconds / 3600).toFixed(2),
          (b.idleSeconds / 3600).toFixed(2),
          (b.productiveSeconds / 3600).toFixed(2),
          b.workingDays,
          b.presentDays,
          b.lateDays,
          b.earlyLeaveDays,
        ]);
      }
    }
    downloadCsv(`timesheet-${from}_to_${to}-${bucket}.csv`, [header, ...body]);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Clock className="h-6 w-6 text-muted-foreground" />
          Timesheets
        </h1>
        <p className="text-sm text-muted-foreground">
          Worked, active and idle hours per device, bucketed by week or month,
          with late-arrival and early-leave counts derived from each device's
          attendance rule.
        </p>
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label htmlFor="ts-group" className="text-xs text-muted-foreground mb-1 block">Team</Label>
            <Select value={groupFilter} onValueChange={setGroupFilter}>
              <SelectTrigger id="ts-group" className="w-full sm:w-40">
                <SelectValue placeholder="All groups" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All groups</SelectItem>
                {groups.map((g) => (
                  <SelectItem key={g} value={g}>{g}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="ts-device" className="text-xs text-muted-foreground mb-1 block">Device (chart)</Label>
            <Select value={selectedDeviceId} onValueChange={setSelectedDeviceId}>
              <SelectTrigger id="ts-device" className="w-full sm:w-44">
                <SelectValue placeholder="All devices" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All devices</SelectItem>
                {devices.map((d) => (
                  <SelectItem key={d.deviceId} value={d.deviceId}>{d.systemName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="ts-bucket" className="text-xs text-muted-foreground mb-1 block">Bucket</Label>
            <Select value={bucket} onValueChange={(v) => setBucket(v as "week" | "month")}>
              <SelectTrigger id="ts-bucket" className="w-full sm:w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="week">Weekly</SelectItem>
                <SelectItem value="month">Monthly</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label htmlFor="ts-from" className="text-xs text-muted-foreground mb-1 block">From</Label>
            <Input id="ts-from" type="date" value={from} max={to}
              onChange={(e) => setRange({ from: e.target.value || daysAgoStr(30) })}
              className="w-40" />
          </div>
          <div>
            <Label htmlFor="ts-to" className="text-xs text-muted-foreground mb-1 block">To</Label>
            <Input id="ts-to" type="date" value={to} min={from}
              onChange={(e) => setRange({ to: e.target.value || from })}
              className="w-40" />
          </div>
          <Button variant="outline" onClick={exportCsv} disabled={!report || devices.length === 0}>
            <Download className="h-4 w-4 mr-2" />
            Export CSV
          </Button>
        </div>
      </div>

      {!valid && (
        <p className="text-sm text-destructive">“From” must be on or before “To”.</p>
      )}
      {isError && (
        <p className="text-sm text-destructive">
          {(error as Error)?.message ?? "Failed to load timesheet."}
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Total worked</p>
          <p className="text-2xl font-bold">{fmtHours(totals.worked)}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Active (worked − idle)</p>
          <p className="text-2xl font-bold text-emerald-600">{fmtHours(totals.active)}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <CalendarClock className="h-3.5 w-3.5" /> Late arrivals
          </p>
          <p className="text-2xl font-bold text-amber-600">{totals.lateDays}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <LogOut className="h-3.5 w-3.5" /> Early leaves
          </p>
          <p className="text-2xl font-bold text-orange-600">{totals.earlyLeaveDays}</p>
        </CardContent></Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            {bucket === "week" ? "Weekly" : "Monthly"} hours
            {singleDevice && (
              <span className="text-muted-foreground font-normal">
                {" "}— {devices.find((d) => d.deviceId === selectedDeviceId)?.systemName}
              </span>
            )}
          </CardTitle>
          <CardDescription>
            Worked, productive and idle hours per {bucket}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {chartData.length === 0 ? (
            <div className="h-56 flex items-center justify-center text-muted-foreground text-sm">
              {isLoading ? "Loading..." : "No activity in this range."}
            </div>
          ) : (
            <ChartContainer config={CHART_CONFIG} className="h-72 w-full">
              <BarChart data={chartData}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
                <YAxis tickLine={false} axisLine={false} width={32} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar dataKey="workedHours" fill="var(--color-workedHours)" radius={4} />
                <Bar dataKey="productiveHours" fill="var(--color-productiveHours)" radius={4} />
                <Bar dataKey="idleHours" fill="var(--color-idleHours)" radius={4} />
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Per-device summary</CardTitle>
          <CardDescription>
            Totals across {report?.from ?? from} → {report?.to ?? to}.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Device</TableHead>
                <TableHead>Group</TableHead>
                <TableHead className="text-right">Worked</TableHead>
                <TableHead className="text-right">Active</TableHead>
                <TableHead className="text-right">Idle</TableHead>
                <TableHead className="text-right">Productive</TableHead>
                <TableHead className="text-right">Present</TableHead>
                <TableHead className="text-right">Late</TableHead>
                <TableHead className="text-right">Early</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={9} className="h-32 text-center text-muted-foreground">Loading...</TableCell></TableRow>
              ) : devices.length === 0 ? (
                <TableRow><TableCell colSpan={9} className="h-32 text-center text-muted-foreground">No devices in this range.</TableCell></TableRow>
              ) : (
                devices.map((d) => (
                  <TableRow key={d.deviceId}>
                    <TableCell className="font-medium">{d.systemName}</TableCell>
                    <TableCell><Badge variant="secondary" className="font-normal">{d.deviceGroup}</Badge></TableCell>
                    <TableCell className="text-right text-sm">{fmtHours(d.totalWorkedSeconds)}</TableCell>
                    <TableCell className="text-right text-sm text-emerald-600">{fmtHours(d.totalActiveSeconds)}</TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground">{fmtHours(d.totalIdleSeconds)}</TableCell>
                    <TableCell className="text-right text-sm">{fmtHours(d.totalProductiveSeconds)}</TableCell>
                    <TableCell className="text-right text-sm">{d.presentDays}/{d.workingDays}</TableCell>
                    <TableCell className="text-right">
                      {d.lateDays > 0 ? (
                        <Badge variant="outline" className="bg-amber-500/15 text-amber-700 border-amber-500/20">{d.lateDays}</Badge>
                      ) : <span className="text-sm text-muted-foreground">0</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      {d.earlyLeaveDays > 0 ? (
                        <Badge variant="outline" className="bg-orange-500/15 text-orange-700 border-orange-500/20">{d.earlyLeaveDays}</Badge>
                      ) : <span className="text-sm text-muted-foreground">0</span>}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
