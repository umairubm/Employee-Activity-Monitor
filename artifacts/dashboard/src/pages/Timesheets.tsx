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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Clock, Download, CalendarClock, LogOut, Columns3 } from "lucide-react";
import { useGroupFilter, ALL_GROUPS as ALL } from "@/hooks/use-group-filter";
import { useDateRange, daysAgoStr } from "@/hooks/use-date-filter";

function fmtHours(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/** Short duration like "5m 11s" / "2h 22m 22s" / "0s". */
function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

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
  const [groupFilter, setGroupFilter] = useGroupFilter();
  const { data: allDevices } = useListDevices();

  const groups = useMemo(() => {
    const set = new Set<string>();
    allDevices?.forEach((d) => set.add(d.deviceGroup));
    return Array.from(set).sort();
  }, [allDevices]);

  const valid = from <= to;
  const params = {
    from,
    to,
    ...(groupFilter !== ALL ? { group: groupFilter } : {}),
  };
  const { data: report, isLoading, isError, error } = useGetTimesheet(params, {
    query: { queryKey: getGetTimesheetQueryKey(params), enabled: valid, refetchInterval: 30000 },
  });

  const rows = report?.rows ?? [];
  const totals = report?.totals;

  type Row = (typeof rows)[number];
  const columns: { id: string; header: string; accessor: (r: Row) => string | number }[] = [
    { id: "date", header: "Date", accessor: (r) => `${r.date}T00:00:00` },
    { id: "deviceGroup", header: "Groups", accessor: (r) => r.deviceGroup },
    { id: "systemName", header: "Computer", accessor: (r) => r.systemName },
    { id: "tokenLabel", header: "Label", accessor: (r) => r.tokenLabel ?? "" },
    { id: "tokenRegion", header: "Region", accessor: (r) => r.tokenRegion ?? "" },
    { id: "username", header: "User", accessor: (r) => r.username ?? "" },
    { id: "firstActivity", header: "First Activity", accessor: (r) => fmtTime(r.firstActivity) },
    { id: "lastActivity", header: "Last Activity", accessor: (r) => fmtTime(r.lastActivity) },
    { id: "lastActivityLog", header: "Last Activity Log", accessor: (r) => fmtDateTime(r.lastActivityLog) },
    { id: "productiveSeconds", header: "Productive", accessor: (r) => fmtDuration(r.productiveSeconds) },
    { id: "unproductiveSeconds", header: "Unproductive", accessor: (r) => fmtDuration(r.unproductiveSeconds) },
    { id: "undefinedSeconds", header: "Undefined", accessor: (r) => fmtDuration(r.undefinedSeconds) },
    { id: "totalSeconds", header: "Total Time", accessor: (r) => fmtDuration(r.totalSeconds) },
    { id: "activeSeconds", header: "Active Time", accessor: (r) => fmtDuration(r.activeSeconds) },
  ];
  const allColumnIds = columns.map((c) => c.id);

  // Which columns to include in the export, persisted so the choice sticks.
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    if (typeof window === "undefined") return allColumnIds;
    try {
      const raw = window.localStorage.getItem("timesheet-export-columns");
      if (!raw) return allColumnIds;
      const parsed = JSON.parse(raw) as string[];
      const valid = parsed.filter((id) => allColumnIds.includes(id));
      return valid.length > 0 ? valid : allColumnIds;
    } catch {
      return allColumnIds;
    }
  });

  const isSelected = (id: string) => selectedIds.includes(id);
  const toggleColumn = (id: string) => {
    setSelectedIds((prev) => {
      // Keep the canonical column order and never allow an empty selection.
      const next = prev.includes(id)
        ? prev.filter((x) => x !== id)
        : [...prev, id];
      const ordered = allColumnIds.filter((c) => next.includes(c));
      const final = ordered.length > 0 ? ordered : [id];
      try {
        window.localStorage.setItem("timesheet-export-columns", JSON.stringify(final));
      } catch {
        /* ignore storage failures */
      }
      return final;
    });
  };

  const exportCsv = () => {
    if (!report) return;
    const chosen = columns.filter((c) => selectedIds.includes(c.id));
    const cols = chosen.length > 0 ? chosen : columns;
    const header = cols.map((c) => c.header);
    const body: (string | number)[][] = rows.map((r) => cols.map((c) => c.accessor(r)));
    downloadCsv(`timesheet-${from}_to_${to}.csv`, [header, ...body]);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Clock className="h-6 w-6 text-muted-foreground" />
          Timesheets
        </h1>
        <p className="text-sm text-muted-foreground">
          Daily work metrics per device — first and last activity, productive,
          unproductive and undefined time, total and active time, with
          late-arrival and early-leave counts derived from each device's
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
                <Columns3 className="h-4 w-4 mr-2" />
                Columns ({selectedIds.length})
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Columns to export</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {columns.map((c) => (
                <DropdownMenuCheckboxItem
                  key={c.id}
                  checked={isSelected(c.id)}
                  onCheckedChange={() => toggleColumn(c.id)}
                  onSelect={(e) => e.preventDefault()}
                >
                  {c.header}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" onClick={exportCsv} disabled={!report || rows.length === 0}>
            <Download className="h-4 w-4 mr-2" />
            Export CSV
          </Button>
        </div>
      </div>

      {!valid && (
        <p className="text-sm text-destructive">"From" must be on or before "To".</p>
      )}
      {isError && (
        <p className="text-sm text-destructive">
          {(error as Error)?.message ?? "Failed to load timesheet."}
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Total time</p>
          <p className="text-2xl font-bold">{fmtHours(totals?.workedSeconds ?? 0)}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Active time</p>
          <p className="text-2xl font-bold text-emerald-600">{fmtHours(totals?.activeSeconds ?? 0)}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <CalendarClock className="h-3.5 w-3.5" /> Late arrivals
          </p>
          <p className="text-2xl font-bold text-amber-600">{totals?.lateDays ?? 0}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <LogOut className="h-3.5 w-3.5" /> Early leaves
          </p>
          <p className="text-2xl font-bold text-orange-600">{totals?.earlyLeaveDays ?? 0}</p>
        </CardContent></Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Daily work metrics</CardTitle>
          <CardDescription>
            One row per device per active day across {report?.from ?? from} → {report?.to ?? to}.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Groups</TableHead>
                  <TableHead>Computer</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>First Activity</TableHead>
                  <TableHead>Last Activity</TableHead>
                  <TableHead>Last Activity Log</TableHead>
                  <TableHead className="text-right">Productive</TableHead>
                  <TableHead className="text-right">Unproductive</TableHead>
                  <TableHead className="text-right">Undefined</TableHead>
                  <TableHead className="text-right">Total Time</TableHead>
                  <TableHead className="text-right">Active Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={14} className="h-32 text-center text-muted-foreground">Loading...</TableCell></TableRow>
                ) : rows.length === 0 ? (
                  <TableRow><TableCell colSpan={14} className="h-32 text-center text-muted-foreground">No activity in this range.</TableCell></TableRow>
                ) : (
                  rows.map((r) => (
                    <TableRow key={`${r.deviceId}-${r.date}`}>
                      <TableCell className="whitespace-nowrap text-sm tabular-nums">{`${r.date}T00:00:00`}</TableCell>
                      <TableCell><Badge variant="secondary" className="font-normal">{r.deviceGroup}</Badge></TableCell>
                      <TableCell className="font-medium whitespace-nowrap">{r.systemName}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{r.tokenLabel ?? <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{r.tokenRegion ? <Badge variant="outline" className="font-normal">{r.tokenRegion}</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{r.username ?? <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm tabular-nums">{fmtTime(r.firstActivity)}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm tabular-nums">{fmtTime(r.lastActivity)}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm tabular-nums text-muted-foreground">{fmtDateTime(r.lastActivityLog)}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums text-emerald-600">{fmtDuration(r.productiveSeconds)}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums text-rose-600">{fmtDuration(r.unproductiveSeconds)}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums text-muted-foreground">{fmtDuration(r.undefinedSeconds)}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums font-medium">{fmtDuration(r.totalSeconds)}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums">{fmtDuration(r.activeSeconds)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
