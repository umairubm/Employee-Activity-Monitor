import React, { useMemo, useState } from "react";
import {
  useGetTimesheet,
  getGetTimesheetQueryKey,
  useListDevices,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
import { Clock, Download, CalendarClock, LogOut, Columns3, Sigma, Search } from "lucide-react";
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
  // `sumValue` marks a column as numeric/summable; `formatSum` renders its total.
  type Column = {
    id: string;
    header: string;
    accessor: (r: Row) => string | number;
    sumValue?: (r: Row) => number;
    formatSum?: (n: number) => string;
  };
  const columns: Column[] = [
    { id: "date", header: "Date", accessor: (r) => `${r.date}T00:00:00` },
    { id: "deviceGroup", header: "Groups", accessor: (r) => r.deviceGroup },
    { id: "systemName", header: "Computer", accessor: (r) => r.systemName },
    { id: "tokenLabel", header: "Label", accessor: (r) => r.tokenLabel ?? "" },
    { id: "tokenRegion", header: "Region", accessor: (r) => r.tokenRegion ?? "" },
    { id: "username", header: "User", accessor: (r) => r.username ?? "" },
    { id: "firstActivity", header: "First Activity", accessor: (r) => fmtTime(r.firstActivity) },
    { id: "lastActivity", header: "Last Activity", accessor: (r) => fmtTime(r.lastActivity) },
    { id: "lastActivityLog", header: "Last Activity Log", accessor: (r) => fmtDateTime(r.lastActivityLog) },
    { id: "productiveSeconds", header: "Productive", accessor: (r) => fmtDuration(r.productiveSeconds), sumValue: (r) => r.productiveSeconds, formatSum: fmtDuration },
    { id: "unproductiveSeconds", header: "Unproductive", accessor: (r) => fmtDuration(r.unproductiveSeconds), sumValue: (r) => r.unproductiveSeconds, formatSum: fmtDuration },
    { id: "undefinedSeconds", header: "Undefined", accessor: (r) => fmtDuration(r.undefinedSeconds), sumValue: (r) => r.undefinedSeconds, formatSum: fmtDuration },
    { id: "totalSeconds", header: "Total Time", accessor: (r) => fmtDuration(r.totalSeconds), sumValue: (r) => r.totalSeconds, formatSum: fmtDuration },
    { id: "activeSeconds", header: "Active Time", accessor: (r) => fmtDuration(r.activeSeconds), sumValue: (r) => r.activeSeconds, formatSum: fmtDuration },
  ];
  const allColumnIds = columns.map((c) => c.id);
  const summableColumns = columns.filter((c) => c.sumValue && c.formatSum);

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

  // Which numeric columns to total in the export/footer, persisted.
  const [sumIds, setSumIds] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem("timesheet-sum-columns");
      if (!raw) return [];
      const parsed = JSON.parse(raw) as string[];
      return parsed.filter((id) => summableColumns.some((c) => c.id === id));
    } catch {
      return [];
    }
  });
  const isSummed = (id: string) => sumIds.includes(id);
  const toggleSum = (id: string) => {
    setSumIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      const ordered = allColumnIds.filter((c) => next.includes(c));
      try {
        window.localStorage.setItem("timesheet-sum-columns", JSON.stringify(ordered));
      } catch {
        /* ignore storage failures */
      }
      return ordered;
    });
  };

  // Conditional filter on Active Time / Total Time (threshold as hours + minutes).
  const [filterField, setFilterField] = useState<"none" | "activeSeconds" | "totalSeconds">("none");
  const [filterOp, setFilterOp] = useState<"lt" | "gt">("gt");
  const [filterHours, setFilterHours] = useState<string>("");
  const [filterMinutes, setFilterMinutes] = useState<string>("");
  const [search, setSearch] = useState("");

  const searchTerm = search.trim().toLocaleLowerCase();
  const hoursNum = filterHours.trim() === "" ? 0 : Number(filterHours);
  const minsNum = filterMinutes.trim() === "" ? 0 : Number(filterMinutes);
  const durationProvided = filterHours.trim() !== "" || filterMinutes.trim() !== "";
  const durationValid =
    Number.isFinite(hoursNum) && Number.isFinite(minsNum) && hoursNum >= 0 && minsNum >= 0;
  const filterActive = filterField !== "none" && durationProvided && durationValid;

  const filteredRows = useMemo(() => {
    const threshold = hoursNum * 3600 + minsNum * 60;
    return rows.filter((r) => {
      const searchableValues = [
        r.date,
        r.systemName,
        r.tokenLabel,
        r.tokenRegion,
        r.username,
        r.deviceGroup,
      ];
      const matchesSearch =
        searchTerm === "" ||
        searchableValues.some((value) =>
          value?.toLocaleLowerCase().includes(searchTerm),
        );
      if (!matchesSearch) return false;
      if (!filterActive) return true;
      const v = filterField === "activeSeconds" ? r.activeSeconds : r.totalSeconds;
      return filterOp === "lt" ? v < threshold : v > threshold;
    });
  }, [rows, searchTerm, filterActive, filterField, filterOp, hoursNum, minsNum]);

  const tableFilterActive = filterActive || searchTerm !== "";

  // Summary totals follow the visible table: when a search or duration filter
  // is active, the Total/Active cards sum only displayed rows; clearing both
  // restores the server-computed unfiltered report totals.
  const displayedTotals = useMemo(() => {
    if (!tableFilterActive) {
      return {
        workedSeconds: totals?.workedSeconds ?? 0,
        activeSeconds: totals?.activeSeconds ?? 0,
      };
    }
    return filteredRows.reduce(
      (acc, r) => {
        acc.workedSeconds += r.totalSeconds;
        acc.activeSeconds += r.activeSeconds;
        return acc;
      },
      { workedSeconds: 0, activeSeconds: 0 },
    );
  }, [tableFilterActive, filteredRows, totals]);

  const clearFilter = () => {
    setFilterField("none");
    setFilterHours("");
    setFilterMinutes("");
  };

  // Totals for the currently-displayed (filtered) rows, keyed by column id.
  const sumsById = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const c of summableColumns) {
      if (!sumIds.includes(c.id)) continue;
      acc[c.id] = filteredRows.reduce((sum, r) => sum + (c.sumValue!(r) ?? 0), 0);
    }
    return acc;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredRows, sumIds]);

  const exportCsv = () => {
    if (!report) return;
    const chosen = columns.filter((c) => selectedIds.includes(c.id));
    const cols = chosen.length > 0 ? chosen : columns;
    const header = cols.map((c) => c.header);
    const body: (string | number)[][] = filteredRows.map((r) => cols.map((c) => c.accessor(r)));
    // Append a totals row only when at least one summed column is actually exported.
    if (cols.some((c) => sumIds.includes(c.id))) {
      const sumRow = cols.map((c, idx) => {
        if (sumIds.includes(c.id) && c.sumValue && c.formatSum) {
          return c.formatSum(filteredRows.reduce((s, r) => s + (c.sumValue!(r) ?? 0), 0));
        }
        return idx === 0 ? "TOTAL" : "";
      });
      body.push(sumRow);
    }
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

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="relative">
            <Label htmlFor="ts-search" className="text-xs text-muted-foreground mb-1 block">Search</Label>
            <Search className="absolute left-2.5 top-8 h-4 w-4 text-muted-foreground" />
            <Input
              id="ts-search"
              type="search"
              placeholder="Computer, user, label..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 sm:w-56"
            />
          </div>
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
            <Label htmlFor="ts-filter-field" className="text-xs text-muted-foreground mb-1 block">Filter</Label>
            <Select value={filterField} onValueChange={(v) => setFilterField(v as typeof filterField)}>
              <SelectTrigger id="ts-filter-field" className="w-full sm:w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No filter</SelectItem>
                <SelectItem value="activeSeconds">Active Time</SelectItem>
                <SelectItem value="totalSeconds">Total Time</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="ts-filter-op" className="text-xs text-muted-foreground mb-1 block">Is</Label>
            <Select
              value={filterOp}
              onValueChange={(v) => setFilterOp(v as typeof filterOp)}
              disabled={filterField === "none"}
            >
              <SelectTrigger id="ts-filter-op" className="w-full sm:w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="gt">&gt; (more than)</SelectItem>
                <SelectItem value="lt">&lt; (less than)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end gap-2">
            <div>
              <Label htmlFor="ts-filter-hrs" className="text-xs text-muted-foreground mb-1 block">Hours</Label>
              <Input
                id="ts-filter-hrs"
                type="number"
                min={0}
                inputMode="numeric"
                placeholder="e.g. 2"
                value={filterHours}
                onChange={(e) => setFilterHours(e.target.value)}
                disabled={filterField === "none"}
                className="w-24"
              />
            </div>
            <div>
              <Label htmlFor="ts-filter-min" className="text-xs text-muted-foreground mb-1 block">Minutes</Label>
              <Input
                id="ts-filter-min"
                type="number"
                min={0}
                max={59}
                inputMode="numeric"
                placeholder="e.g. 30"
                value={filterMinutes}
                onChange={(e) => setFilterMinutes(e.target.value)}
                disabled={filterField === "none"}
                className="w-24"
              />
            </div>
          </div>
          {filterActive && (
            <Button variant="ghost" size="sm" onClick={clearFilter}>
              Clear
            </Button>
          )}
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
                <Sigma className="h-4 w-4 mr-2" />
                Sum ({sumIds.length})
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Columns to total</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {summableColumns.map((c) => (
                <DropdownMenuCheckboxItem
                  key={c.id}
                  checked={isSummed(c.id)}
                  onCheckedChange={() => toggleSum(c.id)}
                  onSelect={(e) => e.preventDefault()}
                >
                  {c.header}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" onClick={exportCsv} disabled={!report || filteredRows.length === 0}>
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
          <p className="text-xs text-muted-foreground">Total time{tableFilterActive && <span className="ml-1 text-[10px] uppercase tracking-wide text-primary">(filtered)</span>}</p>
          <p className="text-2xl font-bold">{fmtHours(displayedTotals.workedSeconds)}</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Active time{tableFilterActive && <span className="ml-1 text-[10px] uppercase tracking-wide text-primary">(filtered)</span>}</p>
          <p className="text-2xl font-bold text-emerald-600">{fmtHours(displayedTotals.activeSeconds)}</p>
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
          <div className="overflow-x-auto pb-2">
            <Table className="min-w-[1400px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Groups</TableHead>
                  <TableHead className="sticky left-0 z-20 w-[170px] min-w-[170px] bg-card">Computer</TableHead>
                  <TableHead className="sticky left-[170px] z-20 w-[140px] min-w-[140px] border-r bg-card">Label</TableHead>
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
                ) : filteredRows.length === 0 ? (
                  <TableRow><TableCell colSpan={14} className="h-32 text-center text-muted-foreground">{tableFilterActive ? "No rows match the active filters." : "No activity in this range."}</TableCell></TableRow>
                ) : (
                  filteredRows.map((r) => (
                    <TableRow key={`${r.deviceId}-${r.date}`} className="group">
                      <TableCell className="whitespace-nowrap text-sm tabular-nums">{`${r.date}T00:00:00`}</TableCell>
                      <TableCell><Badge variant="secondary" className="font-normal">{r.deviceGroup}</Badge></TableCell>
                      <TableCell className="sticky left-0 z-10 w-[170px] min-w-[170px] max-w-[170px] truncate bg-card font-medium whitespace-nowrap transition-colors group-hover:bg-muted" title={r.systemName}>{r.systemName}</TableCell>
                      <TableCell className="sticky left-[170px] z-10 w-[140px] min-w-[140px] max-w-[140px] truncate border-r bg-card whitespace-nowrap text-sm transition-colors group-hover:bg-muted" title={r.tokenLabel ?? undefined}>{r.tokenLabel ?? <span className="text-muted-foreground">—</span>}</TableCell>
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
              {sumIds.length > 0 && filteredRows.length > 0 && (
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={9} className="text-sm font-medium">
                      Sum{filterActive ? " (filtered)" : ""}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums font-medium">{isSummed("productiveSeconds") ? fmtDuration(sumsById.productiveSeconds ?? 0) : ""}</TableCell>
                    <TableCell className="text-right text-sm tabular-nums font-medium">{isSummed("unproductiveSeconds") ? fmtDuration(sumsById.unproductiveSeconds ?? 0) : ""}</TableCell>
                    <TableCell className="text-right text-sm tabular-nums font-medium">{isSummed("undefinedSeconds") ? fmtDuration(sumsById.undefinedSeconds ?? 0) : ""}</TableCell>
                    <TableCell className="text-right text-sm tabular-nums font-medium">{isSummed("totalSeconds") ? fmtDuration(sumsById.totalSeconds ?? 0) : ""}</TableCell>
                    <TableCell className="text-right text-sm tabular-nums font-medium">{isSummed("activeSeconds") ? fmtDuration(sumsById.activeSeconds ?? 0) : ""}</TableCell>
                  </TableRow>
                </TableFooter>
              )}
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
