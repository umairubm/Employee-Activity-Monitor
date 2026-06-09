import React, { useMemo, useState } from "react";
import {
  useGetAttendanceReport,
  getGetAttendanceReportQueryKey,
  useGetAttendanceRangeReport,
  getGetAttendanceRangeReportQueryKey,
  useGetAttendanceSettings,
  getGetAttendanceSettingsQueryKey,
  useUpdateAttendanceSettings,
  useGetAttendanceOverrides,
  getGetAttendanceOverridesQueryKey,
  useUpsertAttendanceOverride,
  useDeleteAttendanceOverride,
  useListDevices,
  type AttendanceOverrideItem,
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
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent, type ChartConfig } from "@/components/ui/chart";
import { CartesianGrid, XAxis, YAxis, Line, ComposedChart, Bar, Cell } from "recharts";
import { CalendarCheck, CalendarRange, Settings2, Clock, Download, TrendingUp } from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
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

function fmtHours(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

const STATUS_STYLE: Record<string, string> = {
  present: "bg-emerald-500/15 text-emerald-700 border-emerald-500/20",
  half_day: "bg-amber-500/15 text-amber-700 border-amber-500/20",
  absent: "bg-muted text-muted-foreground",
  non_working: "bg-sky-500/10 text-sky-700 border-sky-500/20",
};

const CHART_CONFIG = {
  workedHours: { label: "Worked hours", color: "hsl(var(--chart-1))" },
  present: { label: "Devices present", color: "hsl(var(--chart-2))" },
} satisfies ChartConfig;

const STATUS_FILL: Record<string, string> = {
  present: "hsl(var(--chart-2))",
  half_day: "hsl(var(--chart-4))",
  absent: "hsl(var(--muted-foreground))",
};

const STATUS_LABEL: Record<string, string> = {
  present: "Present",
  half_day: "Half-day",
  absent: "Absent",
  non_working: "Non-working",
};

const WEEKDAYS = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

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
  const [groupFilter, setGroupFilter] = useGroupFilter();
  const { data: devices } = useListDevices();
  const groups = useMemo(() => {
    const set = new Set<string>();
    devices?.forEach((d) => set.add(d.deviceGroup));
    return Array.from(set).sort();
  }, [devices]);

  const reportParams = { date, ...(groupFilter !== ALL ? { group: groupFilter } : {}) };
  const { data: report, isLoading } = useGetAttendanceReport(reportParams, {
    query: { queryKey: getGetAttendanceReportQueryKey(reportParams) },
  });

  const counts = useMemo(() => {
    const c = { present: 0, half_day: 0, absent: 0, non_working: 0 };
    report?.devices.forEach((d) => {
      if (d.status in c) c[d.status as keyof typeof c] += 1;
    });
    return c;
  }, [report]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-end gap-2">
        <div>
          <Label htmlFor="day-group" className="text-xs text-muted-foreground mb-1 block">Team</Label>
          <Select value={groupFilter} onValueChange={setGroupFilter}>
            <SelectTrigger id="day-group" className="w-full sm:w-44">
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
          <p className="text-xs text-muted-foreground">
            {report && !report.isWorkingDay ? "Non-working day" : `Required ${report?.isFriday ? "(Friday)" : ""}`}
          </p>
          <p className="text-2xl font-bold flex items-center gap-1">
            <Clock className="h-4 w-4 text-muted-foreground" />
            {report ? (report.isWorkingDay ? `${report.requiredHours}h` : "—") : "-"}
          </p>
        </CardContent></Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <CalendarCheck className="h-5 w-5 text-muted-foreground" />
            {date}
            {report && !report.isWorkingDay && (
              <Badge variant="outline" className={STATUS_STYLE.non_working}>Non-working day</Badge>
            )}
          </CardTitle>
          <CardDescription>
            {report && !report.isWorkingDay
              ? "This is a weekend or holiday, so devices are not marked present or absent."
              : "Attendance is computed from recorded foreground activity for the selected day."}
          </CardDescription>
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
                        {STATUS_LABEL[row.status] ?? row.status}
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
  const [selectedDeviceId, setSelectedDeviceId] = useState("all");
  const [groupFilter, setGroupFilter] = useGroupFilter();
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
  const rangeParams = { from, to, ...(groupFilter !== ALL ? { group: groupFilter } : {}) };
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

  const singleDevice = selectedDeviceId !== "all";

  const chartData = useMemo(() => {
    const daily = report?.daily ?? [];
    if (!singleDevice) {
      return daily.map((d) => ({
        day: d.day,
        label: format(new Date(`${d.day}T00:00:00`), "MMM d"),
        workedHours: Number((d.workedSeconds / 3600).toFixed(2)),
        present: d.presentDevices,
        absent: d.absentDevices,
        status: "" as string,
      }));
    }
    return daily.map((d) => {
      const dev = d.byDevice.find((b) => b.deviceId === selectedDeviceId);
      const workedSeconds = dev?.workedSeconds ?? 0;
      return {
        day: d.day,
        label: format(new Date(`${d.day}T00:00:00`), "MMM d"),
        workedHours: Number((workedSeconds / 3600).toFixed(2)),
        present: 0,
        absent: 0,
        status: dev?.status ?? "absent",
      };
    });
  }, [report, singleDevice, selectedDeviceId]);

  const selectedDeviceName = useMemo(
    () =>
      report?.devices.find((d) => d.deviceId === selectedDeviceId)?.systemName ??
      "All devices",
    [report, selectedDeviceId],
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
          <Label htmlFor="range-group" className="text-xs text-muted-foreground mb-1 block">Team</Label>
          <Select value={groupFilter} onValueChange={setGroupFilter}>
            <SelectTrigger id="range-group" className="w-full sm:w-44">
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
          <p className="text-xs text-muted-foreground">Working days</p>
          <p className="text-2xl font-bold flex items-center gap-1">
            <Clock className="h-4 w-4 text-muted-foreground" />
            {report ? report.workingDays : "-"}
            {report && (
              <span className="text-sm font-normal text-muted-foreground">/ {report.days} total</span>
            )}
          </p>
        </CardContent></Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-muted-foreground" />
                Daily trend
              </CardTitle>
              <CardDescription>
                {singleDevice
                  ? `Worked hours per day for ${selectedDeviceName}, with each bar colored by attendance status.`
                  : "Total worked hours per day (bars) and devices present per day (line) across the selected range."}
              </CardDescription>
            </div>
            <div className="shrink-0">
              <Label htmlFor="device" className="text-xs text-muted-foreground mb-1 block">Device</Label>
              <Select value={selectedDeviceId} onValueChange={setSelectedDeviceId}>
                <SelectTrigger id="device" className="w-56">
                  <SelectValue placeholder="All devices" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All devices</SelectItem>
                  {report?.devices.map((d) => (
                    <SelectItem key={d.deviceId} value={d.deviceId}>
                      {d.systemName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
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
            <>
              <ChartContainer config={CHART_CONFIG} className="aspect-auto h-72 w-full">
                <ComposedChart data={chartData} margin={{ left: 4, right: 4, top: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} />
                  <YAxis yAxisId="left" tickLine={false} axisLine={false} tickMargin={8} width={36} />
                  {!singleDevice && (
                    <YAxis yAxisId="right" orientation="right" tickLine={false} axisLine={false} tickMargin={8} width={28} allowDecimals={false} />
                  )}
                  <ChartTooltip content={<ChartTooltipContent />} />
                  {!singleDevice && <ChartLegend content={<ChartLegendContent />} />}
                  <Bar yAxisId="left" dataKey="workedHours" fill="var(--color-workedHours)" radius={[4, 4, 0, 0]}>
                    {singleDevice &&
                      chartData.map((d) => (
                        <Cell key={d.day} fill={STATUS_FILL[d.status] ?? STATUS_FILL.absent} />
                      ))}
                  </Bar>
                  {!singleDevice && (
                    <Line yAxisId="right" type="monotone" dataKey="present" stroke="var(--color-present)" strokeWidth={2} dot={false} />
                  )}
                </ComposedChart>
              </ChartContainer>
              {singleDevice && (
                <div className="mt-3 flex flex-wrap items-center justify-center gap-4 text-xs text-muted-foreground">
                  {(["present", "half_day", "absent"] as const).map((s) => (
                    <span key={s} className="flex items-center gap-1.5">
                      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: STATUS_FILL[s] }} />
                      {STATUS_LABEL[s]}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <CalendarRange className="h-5 w-5 text-muted-foreground" />
            {from} → {to}
          </CardTitle>
          <CardDescription>Per-device totals across the selected range. Weekends and holidays are excluded; only working days are classified present / half-day / absent, and the daily average is over working days.</CardDescription>
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

const GLOBAL_SCOPE = "global";

/** Encodes the selected scope into a single Select value string. */
function scopeKey(scope: "global" | "group" | "device", id?: string): string {
  if (scope === "global") return GLOBAL_SCOPE;
  return `${scope}:${id}`;
}

export default function Attendance() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: settings } = useGetAttendanceSettings({
    query: { queryKey: getGetAttendanceSettingsQueryKey() },
  });
  const { data: devices } = useListDevices();
  const { data: overrides } = useGetAttendanceOverrides({
    query: { queryKey: getGetAttendanceOverridesQueryKey() },
  });
  const updateSettings = useUpdateAttendanceSettings();
  const upsertOverride = useUpsertAttendanceOverride();
  const deleteOverride = useDeleteAttendanceOverride();

  const groups = useMemo(() => {
    const set = new Set<string>();
    devices?.forEach((d) => set.add(d.deviceGroup));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [devices]);

  const overrideByGroup = useMemo(() => {
    const m = new Map<string, AttendanceOverrideItem>();
    overrides?.forEach((o) => {
      if (o.scope === "group" && o.deviceGroup) m.set(o.deviceGroup, o);
    });
    return m;
  }, [overrides]);

  const overrideByDevice = useMemo(() => {
    const m = new Map<string, AttendanceOverrideItem>();
    overrides?.forEach((o) => {
      if (o.scope === "device" && o.deviceId) m.set(o.deviceId, o);
    });
    return m;
  }, [overrides]);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scopeValue, setScopeValue] = useState<string>(GLOBAL_SCOPE);
  const [form, setForm] = useState({
    workStartTime: "09:00",
    halfDayThresholdHours: "4",
    requiredHoursNormal: "7.5",
    requiredHoursFriday: "7",
  });
  const [workingDays, setWorkingDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [holidaysText, setHolidaysText] = useState("");

  // Parse the encoded scope value into its parts.
  const scope = useMemo(() => {
    if (scopeValue === GLOBAL_SCOPE) return { type: "global" as const };
    const [type, ...rest] = scopeValue.split(":");
    const id = rest.join(":");
    if (type === "group") return { type: "group" as const, group: id };
    return { type: "device" as const, deviceId: id };
  }, [scopeValue]);

  // The existing override row (if any) for the currently selected scope.
  const currentOverride =
    scope.type === "group"
      ? overrideByGroup.get(scope.group)
      : scope.type === "device"
        ? overrideByDevice.get(scope.deviceId)
        : undefined;

  type Rules = {
    workStartTime: string;
    halfDayThresholdHours: number;
    requiredHoursNormal: number;
    requiredHoursFriday: number;
    workingDays: number[];
    holidays: string[];
  };

  const loadRulesIntoForm = (r: Rules) => {
    setForm({
      workStartTime: r.workStartTime,
      halfDayThresholdHours: String(r.halfDayThresholdHours),
      requiredHoursNormal: String(r.requiredHoursNormal),
      requiredHoursFriday: String(r.requiredHoursFriday),
    });
    setWorkingDays([...r.workingDays].sort((a, b) => a - b));
    setHolidaysText(r.holidays.join(", "));
  };

  // Prefill the form for a scope: use its override if defined, otherwise the
  // global default as a starting template (saving then creates an override).
  const loadForScope = (value: string) => {
    setScopeValue(value);
    let row: Rules | undefined;
    if (value === GLOBAL_SCOPE) {
      row = settings ?? undefined;
    } else {
      const [type, ...rest] = value.split(":");
      const id = rest.join(":");
      const ov =
        type === "group" ? overrideByGroup.get(id) : overrideByDevice.get(id);
      row = ov ?? settings ?? undefined;
    }
    if (row) loadRulesIntoForm(row);
  };

  const openSettings = () => {
    loadForScope(GLOBAL_SCOPE);
    setSettingsOpen(true);
  };

  const toggleWorkingDay = (value: number) => {
    setWorkingDays((days) =>
      days.includes(value) ? days.filter((d) => d !== value) : [...days, value].sort((a, b) => a - b),
    );
  };

  const parseHolidays = (): string[] | null => {
    const holidays = holidaysText
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const invalid = holidays.find((h) => !/^\d{4}-\d{2}-\d{2}$/.test(h));
    if (invalid) {
      toast({
        title: "Invalid holiday date",
        description: `"${invalid}" is not in YYYY-MM-DD format.`,
        variant: "destructive",
      });
      return null;
    }
    return holidays;
  };

  const refetchAll = () => {
    queryClient.invalidateQueries({ queryKey: getGetAttendanceSettingsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetAttendanceOverridesQueryKey() });
    queryClient.invalidateQueries();
  };

  const saveSettings = () => {
    const holidays = parseHolidays();
    if (holidays === null) return;
    const rules = {
      workStartTime: form.workStartTime,
      halfDayThresholdHours: Number(form.halfDayThresholdHours),
      requiredHoursNormal: Number(form.requiredHoursNormal),
      requiredHoursFriday: Number(form.requiredHoursFriday),
      workingDays,
      holidays,
    };

    if (scope.type === "global") {
      updateSettings.mutate(
        { data: rules },
        {
          onSuccess: () => {
            refetchAll();
            toast({ title: "Global attendance rules updated" });
            setSettingsOpen(false);
          },
          onError: (error: any) => {
            toast({ title: "Failed to update rules", description: error.message, variant: "destructive" });
          },
        },
      );
      return;
    }

    const data =
      scope.type === "group"
        ? { scope: "group" as const, deviceGroup: scope.group, ...rules }
        : { scope: "device" as const, deviceId: scope.deviceId, ...rules };

    upsertOverride.mutate(
      { data },
      {
        onSuccess: () => {
          refetchAll();
          toast({ title: "Override saved" });
          setSettingsOpen(false);
        },
        onError: (error: any) => {
          toast({ title: "Failed to save override", description: error.message, variant: "destructive" });
        },
      },
    );
  };

  const removeOverride = () => {
    if (!currentOverride) return;
    deleteOverride.mutate(
      { id: currentOverride.id },
      {
        onSuccess: () => {
          refetchAll();
          toast({ title: "Override removed" });
          // Fall back to showing the inherited rule for this scope.
          if (settings) loadRulesIntoForm(settings);
        },
        onError: (error: any) => {
          toast({ title: "Failed to remove override", description: error.message, variant: "destructive" });
        },
      },
    );
  };

  const deviceName = (deviceId: string) =>
    devices?.find((d) => d.id === deviceId)?.systemName ?? deviceId;

  const inheritedNote =
    scope.type === "device"
      ? overrideByDevice.get(scope.deviceId)
        ? "This device has its own override."
        : (() => {
            const dev = devices?.find((d) => d.id === scope.deviceId);
            return dev && overrideByGroup.has(dev.deviceGroup)
              ? `Inheriting from team "${dev.deviceGroup}". Saving creates a device override.`
              : "Inheriting the global default. Saving creates a device override.";
          })()
      : scope.type === "group"
        ? overrideByGroup.get(scope.group)
          ? "This team has its own override."
          : "Inheriting the global default. Saving creates a team override."
        : "The global default applies to every device without a team or device override.";

  const saving = updateSettings.isPending || upsertOverride.isPending;

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
          <DialogContent className="max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Attendance Rules</DialogTitle>
              <CardDescription>
                Set a global default, then override working days, holidays, and
                required hours per team or per device.
              </CardDescription>
            </DialogHeader>

            <div className="space-y-1 py-1">
              <Label htmlFor="scope">Applies to</Label>
              <Select value={scopeValue} onValueChange={loadForScope}>
                <SelectTrigger id="scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={GLOBAL_SCOPE}>Global default</SelectItem>
                  {groups.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>Teams</SelectLabel>
                      {groups.map((g) => (
                        <SelectItem key={`g:${g}`} value={scopeKey("group", g)}>
                          {g}
                          {overrideByGroup.has(g) ? " ·  override" : ""}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                  {devices && devices.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>Devices</SelectLabel>
                      {devices.map((d) => (
                        <SelectItem key={`d:${d.id}`} value={scopeKey("device", d.id)}>
                          {d.systemName}
                          {overrideByDevice.has(d.id) ? " ·  override" : ""}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{inheritedNote}</p>
            </div>

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
              <div className="space-y-1 col-span-2">
                <Label>Working days</Label>
                <div className="flex flex-wrap gap-1.5">
                  {WEEKDAYS.map((d) => {
                    const active = workingDays.includes(d.value);
                    return (
                      <Button
                        key={d.value}
                        type="button"
                        size="sm"
                        variant={active ? "default" : "outline"}
                        className="h-8 w-12 px-0"
                        onClick={() => toggleWorkingDay(d.value)}
                      >
                        {d.label}
                      </Button>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">Days not selected (e.g. weekends) are excluded from attendance counts.</p>
              </div>
              <div className="space-y-1 col-span-2">
                <Label htmlFor="holidays">Holidays</Label>
                <Input
                  id="holidays"
                  placeholder="2026-01-01, 2026-12-25"
                  value={holidaysText}
                  onChange={(e) => setHolidaysText(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Comma-separated YYYY-MM-DD dates, treated as non-working days.</p>
              </div>
            </div>
            <DialogFooter className="gap-2 sm:justify-between">
              {currentOverride ? (
                <Button
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={removeOverride}
                  disabled={deleteOverride.isPending}
                >
                  {deleteOverride.isPending ? "Removing..." : "Remove override"}
                </Button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setSettingsOpen(false)}>Cancel</Button>
                <Button onClick={saveSettings} disabled={saving}>
                  {saving
                    ? "Saving..."
                    : scope.type === "global"
                      ? "Save rules"
                      : "Save override"}
                </Button>
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {overrides && overrides.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Settings2 className="h-4 w-4 text-muted-foreground" /> Active overrides
            </CardTitle>
            <CardDescription>
              These teams and devices use their own attendance rules instead of the global default.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {overrides.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => {
                  loadForScope(
                    o.scope === "group"
                      ? scopeKey("group", o.deviceGroup ?? "")
                      : scopeKey("device", o.deviceId ?? ""),
                  );
                  setSettingsOpen(true);
                }}
                className="group inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm hover:bg-muted transition-colors"
              >
                <Badge variant="secondary" className="font-normal">
                  {o.scope === "group" ? "Team" : "Device"}
                </Badge>
                <span className="font-medium">
                  {o.scope === "group" ? o.deviceGroup : o.deviceName ?? deviceName(o.deviceId ?? "")}
                </span>
              </button>
            ))}
          </CardContent>
        </Card>
      )}

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
