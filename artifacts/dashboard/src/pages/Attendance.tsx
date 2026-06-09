import React, { useMemo, useState } from "react";
import {
  useGetAttendanceReport,
  getGetAttendanceReportQueryKey,
  useGetAttendanceRangeReport,
  getGetAttendanceRangeReportQueryKey,
  useGetAttendanceSettings,
  getGetAttendanceSettingsQueryKey,
  useUpdateAttendanceSettings,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent, type ChartConfig } from "@/components/ui/chart";
import { CartesianGrid, XAxis, YAxis, Line, ComposedChart, Bar } from "recharts";
import { CalendarCheck, CalendarRange, Settings2, Clock, Download, TrendingUp } from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtHours(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

const STATUS_STYLE: Record<string, string> = {
  present: "bg-emerald-500/15 text-emerald-700 border-emerald-500/20",
  half_day: "bg-amber-500/15 text-amber-700 border-amber-500/20",
  absent: "bg-muted text-muted-foreground",
};

const CHART_CONFIG = {
  workedHours: { label: "Worked hours", color: "hsl(var(--chart-1))" },
  present: { label: "Devices present", color: "hsl(var(--chart-2))" },
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

function DayView() {
  const [date, setDate] = useState(todayStr());

  const reportParams = { date };
  const { data: report, isLoading } = useGetAttendanceReport(reportParams, {
    query: { queryKey: getGetAttendanceReportQueryKey(reportParams) },
  });

  const counts = useMemo(() => {
    const c = { present: 0, half_day: 0, absent: 0 };
    report?.devices.forEach((d) => {
      c[d.status as keyof typeof c] += 1;
    });
    return c;
  }, [report]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-end">
        <div>
          <Label htmlFor="date" className="text-xs text-muted-foreground mb-1 block">Date</Label>
          <Input
            id="date"
            type="date"
            value={date}
            max={todayStr()}
            onChange={(e) => setDate(e.target.value || todayStr())}
            className="w-44"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Present</p>
          <p className="text-2xl font-bold text-emerald-600">{counts.present}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Half-day</p>
          <p className="text-2xl font-bold text-amber-600">{counts.half_day}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Absent</p>
          <p className="text-2xl font-bold text-muted-foreground">{counts.absent}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Required {report?.isFriday ? "(Friday)" : ""}</p>
          <p className="text-2xl font-bold flex items-center gap-1">
            <Clock className="h-4 w-4 text-muted-foreground" />
            {report ? `${report.requiredHours}h` : "-"}
          </p>
        </CardContent></Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <CalendarCheck className="h-5 w-5 text-muted-foreground" />
            {date}
          </CardTitle>
          <CardDescription>Attendance is computed from recorded foreground activity for the selected day.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Device</TableHead>
                <TableHead>Group</TableHead>
                <TableHead>Check-in</TableHead>
                <TableHead>Worked</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={5} className="h-32 text-center text-muted-foreground">Loading...</TableCell></TableRow>
              ) : report?.devices.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="h-32 text-center text-muted-foreground">No devices enrolled.</TableCell></TableRow>
              ) : (
                report?.devices.map((row) => (
                  <TableRow key={row.deviceId}>
                    <TableCell className="font-medium">{row.systemName}</TableCell>
                    <TableCell><Badge variant="secondary" className="font-normal">{row.deviceGroup}</Badge></TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.checkIn ? format(new Date(row.checkIn), "HH:mm") : "-"}
                    </TableCell>
                    <TableCell className="text-sm">{fmtHours(row.workedSeconds)}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={STATUS_STYLE[row.status]}>
                        {row.status === "half_day" ? "Half-day" : row.status.charAt(0).toUpperCase() + row.status.slice(1)}
                      </Badge>
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

function RangeView() {
  const { toast } = useToast();
  const [from, setFrom] = useState(daysAgoStr(6));
  const [to, setTo] = useState(todayStr());

  const valid = from <= to;
  const rangeParams = { from, to };
  const { data: report, isLoading, isError, error } = useGetAttendanceRangeReport(rangeParams, {
    query: {
      queryKey: getGetAttendanceRangeReportQueryKey(rangeParams),
      enabled: valid,
    },
  });

  const totals = useMemo(() => {
    const t = { present: 0, half_day: 0, absent: 0, worked: 0 };
    report?.devices.forEach((d) => {
      t.present += d.presentDays;
      t.half_day += d.halfDays;
      t.absent += d.absentDays;
      t.worked += d.totalWorkedSeconds;
    });
    return t;
  }, [report]);

  const chartData = useMemo(
    () =>
      (report?.daily ?? []).map((d) => ({
        day: d.day,
        label: format(new Date(`${d.day}T00:00:00`), "MMM d"),
        workedHours: Number((d.workedSeconds / 3600).toFixed(2)),
        present: d.presentDevices,
        absent: d.absentDevices,
      })),
    [report],
  );

  const exportCsv = () => {
    if (!report) return;
    const header = [
      "Device",
      "Group",
      "Days present",
      "Half-days",
      "Days absent",
      "Total worked (hours)",
      "Avg worked/day (hours)",
    ];
    const body = report.devices.map((d) => [
      d.systemName,
      d.deviceGroup,
      d.presentDays,
      d.halfDays,
      d.absentDays,
      (d.totalWorkedSeconds / 3600).toFixed(2),
      (d.avgWorkedSeconds / 3600).toFixed(2),
    ]);
    downloadCsv(`attendance_${report.from}_to_${report.to}.csv`, [header, ...body]);
    toast({ title: "CSV exported" });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-end gap-2">
        <div>
          <Label htmlFor="from" className="text-xs text-muted-foreground mb-1 block">From</Label>
          <Input
            id="from"
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value || daysAgoStr(6))}
            className="w-44"
          />
        </div>
        <div>
          <Label htmlFor="to" className="text-xs text-muted-foreground mb-1 block">To</Label>
          <Input
            id="to"
            type="date"
            value={to}
            min={from}
            max={todayStr()}
            onChange={(e) => setTo(e.target.value || todayStr())}
            className="w-44"
          />
        </div>
        <Button variant="outline" className="gap-2" onClick={exportCsv} disabled={!report || report.devices.length === 0}>
          <Download className="h-4 w-4" /> Export CSV
        </Button>
      </div>

      {!valid && (
        <p className="text-sm text-destructive">“From” must be on or before “To”.</p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Present (device-days)</p>
          <p className="text-2xl font-bold text-emerald-600">{totals.present}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Half-days</p>
          <p className="text-2xl font-bold text-amber-600">{totals.half_day}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Absent (device-days)</p>
          <p className="text-2xl font-bold text-muted-foreground">{totals.absent}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Days in range</p>
          <p className="text-2xl font-bold flex items-center gap-1">
            <Clock className="h-4 w-4 text-muted-foreground" />
            {report ? report.days : "-"}
          </p>
        </CardContent></Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-muted-foreground" />
            Daily trend
          </CardTitle>
          <CardDescription>Total worked hours per day (bars) and devices present per day (line) across the selected range.</CardDescription>
        </CardHeader>
        <CardContent>
          {!valid ? (
            <div className="h-72 flex items-center justify-center text-muted-foreground">Choose a valid date range.</div>
          ) : isLoading ? (
            <div className="h-72 flex items-center justify-center text-muted-foreground">Loading...</div>
          ) : isError ? (
            <div className="h-72 flex items-center justify-center text-destructive">{(error as Error)?.message ?? "Failed to load report."}</div>
          ) : chartData.length === 0 ? (
            <div className="h-72 flex items-center justify-center text-muted-foreground">No data in this range.</div>
          ) : (
            <ChartContainer config={CHART_CONFIG} className="aspect-auto h-72 w-full">
              <ComposedChart data={chartData} margin={{ left: 4, right: 4, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} />
                <YAxis yAxisId="left" tickLine={false} axisLine={false} tickMargin={8} width={36} />
                <YAxis yAxisId="right" orientation="right" tickLine={false} axisLine={false} tickMargin={8} width={28} allowDecimals={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar yAxisId="left" dataKey="workedHours" fill="var(--color-workedHours)" radius={[4, 4, 0, 0]} />
                <Line yAxisId="right" type="monotone" dataKey="present" stroke="var(--color-present)" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <CalendarRange className="h-5 w-5 text-muted-foreground" />
            {from} → {to}
          </CardTitle>
          <CardDescription>Per-device totals across the selected range. Each day is classified present / half-day / absent using the attendance rules.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Device</TableHead>
                <TableHead>Group</TableHead>
                <TableHead className="text-right">Present</TableHead>
                <TableHead className="text-right">Half-day</TableHead>
                <TableHead className="text-right">Absent</TableHead>
                <TableHead className="text-right">Total worked</TableHead>
                <TableHead className="text-right">Avg / day</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!valid ? (
                <TableRow><TableCell colSpan={7} className="h-32 text-center text-muted-foreground">Choose a valid date range.</TableCell></TableRow>
              ) : isLoading ? (
                <TableRow><TableCell colSpan={7} className="h-32 text-center text-muted-foreground">Loading...</TableCell></TableRow>
              ) : isError ? (
                <TableRow><TableCell colSpan={7} className="h-32 text-center text-destructive">{(error as Error)?.message ?? "Failed to load report."}</TableCell></TableRow>
              ) : report?.devices.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="h-32 text-center text-muted-foreground">No devices enrolled.</TableCell></TableRow>
              ) : (
                report?.devices.map((row) => (
                  <TableRow key={row.deviceId}>
                    <TableCell className="font-medium">{row.systemName}</TableCell>
                    <TableCell><Badge variant="secondary" className="font-normal">{row.deviceGroup}</Badge></TableCell>
                    <TableCell className="text-right tabular-nums text-emerald-700">{row.presentDays}</TableCell>
                    <TableCell className="text-right tabular-nums text-amber-700">{row.halfDays}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{row.absentDays}</TableCell>
                    <TableCell className="text-right tabular-nums text-sm">{fmtHours(row.totalWorkedSeconds)}</TableCell>
                    <TableCell className="text-right tabular-nums text-sm">{fmtHours(row.avgWorkedSeconds)}</TableCell>
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

export default function Attendance() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: settings } = useGetAttendanceSettings({
    query: { queryKey: getGetAttendanceSettingsQueryKey() },
  });
  const updateSettings = useUpdateAttendanceSettings();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [form, setForm] = useState({
    workStartTime: "09:00",
    halfDayThresholdHours: "4",
    requiredHoursNormal: "7.5",
    requiredHoursFriday: "7",
  });

  const openSettings = () => {
    if (settings) {
      setForm({
        workStartTime: settings.workStartTime,
        halfDayThresholdHours: String(settings.halfDayThresholdHours),
        requiredHoursNormal: String(settings.requiredHoursNormal),
        requiredHoursFriday: String(settings.requiredHoursFriday),
      });
    }
    setSettingsOpen(true);
  };

  const saveSettings = () => {
    updateSettings.mutate(
      {
        data: {
          workStartTime: form.workStartTime,
          halfDayThresholdHours: Number(form.halfDayThresholdHours),
          requiredHoursNormal: Number(form.requiredHoursNormal),
          requiredHoursFriday: Number(form.requiredHoursFriday),
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetAttendanceSettingsQueryKey() });
          queryClient.invalidateQueries();
          toast({ title: "Attendance rules updated" });
          setSettingsOpen(false);
        },
        onError: (error: any) => {
          toast({ title: "Failed to update rules", description: error.message, variant: "destructive" });
        },
      },
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Attendance</h1>
          <p className="text-muted-foreground mt-1">
            Check-in and worked hours, derived from activity logs.
          </p>
        </div>
        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" className="gap-2" onClick={openSettings}>
              <Settings2 className="h-4 w-4" /> Rules
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Attendance Rules</DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-4 py-2">
              <div className="space-y-1">
                <Label htmlFor="workStartTime">Work start time</Label>
                <Input id="workStartTime" type="time" value={form.workStartTime} onChange={(e) => setForm((f) => ({ ...f, workStartTime: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="halfDay">Half-day threshold (hrs)</Label>
                <Input id="halfDay" type="number" step="0.5" min="0" max="24" value={form.halfDayThresholdHours} onChange={(e) => setForm((f) => ({ ...f, halfDayThresholdHours: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="reqNormal">Required hours (normal)</Label>
                <Input id="reqNormal" type="number" step="0.5" min="0" max="24" value={form.requiredHoursNormal} onChange={(e) => setForm((f) => ({ ...f, requiredHoursNormal: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="reqFriday">Required hours (Friday)</Label>
                <Input id="reqFriday" type="number" step="0.5" min="0" max="24" value={form.requiredHoursFriday} onChange={(e) => setForm((f) => ({ ...f, requiredHoursFriday: e.target.value }))} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setSettingsOpen(false)}>Cancel</Button>
              <Button onClick={saveSettings} disabled={updateSettings.isPending}>
                {updateSettings.isPending ? "Saving..." : "Save rules"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Tabs defaultValue="day">
        <TabsList>
          <TabsTrigger value="day" className="gap-2"><CalendarCheck className="h-4 w-4" /> Day</TabsTrigger>
          <TabsTrigger value="range" className="gap-2"><CalendarRange className="h-4 w-4" /> Range</TabsTrigger>
        </TabsList>
        <TabsContent value="day" className="mt-6">
          <DayView />
        </TabsContent>
        <TabsContent value="range" className="mt-6">
          <RangeView />
        </TabsContent>
      </Tabs>
    </div>
  );
}
