import React, { useMemo, useState } from "react";
import {
  useGetActivityLogs,
  getGetActivityLogsQueryKey,
  useListDevices,
  type DeviceItem,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format, formatDistanceToNow } from "date-fns";
import {
  Activity,
  Search,
  Clock,
  AppWindow,
  MonitorSmartphone,
  CheckCircle2,
  XCircle,
  ChevronRight,
} from "lucide-react";
import { useGroupFilter, ALL_GROUPS as ALL } from "@/hooks/use-group-filter";

function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

/** Right slide-over showing the selected device's recent foreground activity. */
function DeviceActivityPanel({ device }: { device: DeviceItem }) {
  const [search, setSearch] = useState("");
  const params = { deviceId: device.id, limit: 200 };
  const { data: logs, isLoading } = useGetActivityLogs(params, {
    query: { queryKey: getGetActivityLogsQueryKey(params) },
  });

  const filteredLogs = logs?.filter(
    (log) =>
      log.processName.toLowerCase().includes(search.toLowerCase()) ||
      (log.windowTitle && log.windowTitle.toLowerCase().includes(search.toLowerCase())),
  );

  return (
    <>
      <SheetHeader className="space-y-1">
        <SheetTitle className="flex items-center gap-2">
          <MonitorSmartphone className="h-5 w-5 text-muted-foreground" />
          {device.systemName}
        </SheetTitle>
        <SheetDescription className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="font-normal">{device.deviceGroup}</Badge>
          <span className="capitalize text-xs">{device.osType}</span>
          {device.online ? (
            <span className="inline-flex items-center gap-1 text-xs text-emerald-600 font-medium">
              <CheckCircle2 className="h-3.5 w-3.5" /> Online
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <XCircle className="h-3.5 w-3.5" /> Offline
            </span>
          )}
        </SheetDescription>
      </SheetHeader>

      <div className="relative mt-4">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          type="search"
          placeholder="Search processes or window titles..."
          className="pl-9"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <ScrollArea className="mt-4 flex-1 -mx-6 px-6">
        {isLoading ? (
          <div className="space-y-3 animate-pulse py-2">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="h-16 bg-muted rounded-md" />
            ))}
          </div>
        ) : !filteredLogs || filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
            <Activity className="h-8 w-8 mb-2 opacity-20" />
            No activity logged for this device yet.
          </div>
        ) : (
          <div className="space-y-2 py-1">
            {filteredLogs.map((log) => (
              <div
                key={log.id}
                className="rounded-lg border bg-card p-3 transition-colors hover:bg-accent/40"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-medium">
                      <AppWindow className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{log.processName}</span>
                    </div>
                    {log.windowTitle && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground" title={log.windowTitle}>
                        {log.windowTitle}
                      </p>
                    )}
                  </div>
                  <Badge variant="secondary" className="shrink-0 font-mono bg-secondary/50">
                    {formatDuration(log.durationSeconds)}
                  </Badge>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5" />
                    {format(new Date(log.startedAt), "MMM d, HH:mm:ss")}
                  </span>
                  <span
                    className={
                      log.idleSeconds > 0
                        ? "font-medium text-amber-600 dark:text-amber-500"
                        : "text-muted-foreground"
                    }
                  >
                    {log.idleSeconds > 0 ? `Idle ${formatDuration(log.idleSeconds)}` : "Active"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </>
  );
}

export default function ActivityLogs() {
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useGroupFilter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data: devices, isLoading } = useListDevices();

  const groups = useMemo(() => {
    const set = new Set<string>();
    devices?.forEach((d) => set.add(d.deviceGroup));
    return Array.from(set).sort();
  }, [devices]);

  const filteredDevices = devices?.filter((d) => {
    const matchesSearch =
      d.systemName.toLowerCase().includes(search.toLowerCase()) ||
      d.hardwareHash.toLowerCase().includes(search.toLowerCase());
    const matchesGroup = groupFilter === ALL || d.deviceGroup === groupFilter;
    return matchesSearch && matchesGroup;
  });

  const selectedDevice = devices?.find((d) => d.id === selectedId) ?? null;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Activity Logs</h1>
          <p className="text-muted-foreground mt-1">
            Select a device to view its foreground application activity.
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
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
          <div className="relative w-full sm:w-80">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search devices..."
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 space-y-4 animate-pulse">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-12 bg-muted rounded-md" />
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Device</TableHead>
                  <TableHead>Group</TableHead>
                  <TableHead>OS</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Seen</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredDevices?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                      <div className="flex flex-col items-center justify-center">
                        <MonitorSmartphone className="h-8 w-8 mb-2 opacity-20" />
                        No devices found.
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredDevices?.map((device) => (
                    <TableRow
                      key={device.id}
                      className="cursor-pointer group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      role="button"
                      tabIndex={0}
                      aria-label={`View activity for ${device.systemName}`}
                      onClick={() => setSelectedId(device.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelectedId(device.id);
                        }
                      }}
                    >
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <MonitorSmartphone className="h-4 w-4 text-muted-foreground" />
                          {device.systemName}
                          {device.isLocked && (
                            <Badge variant="destructive" className="ml-1 text-[10px]">
                              Locked
                            </Badge>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground font-mono mt-1">
                          {device.hardwareHash.substring(0, 8)}...
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="font-normal">
                          {device.deviceGroup}
                        </Badge>
                      </TableCell>
                      <TableCell className="capitalize">{device.osType}</TableCell>
                      <TableCell>
                        {device.online ? (
                          <div className="flex items-center gap-1.5 text-emerald-600 font-medium text-sm">
                            <CheckCircle2 className="h-4 w-4" /> Online
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 text-muted-foreground text-sm">
                            <XCircle className="h-4 w-4" /> Offline
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        <div className="flex items-center gap-1.5">
                          <Clock className="h-3.5 w-3.5" />
                          {device.lastSeenAt
                            ? formatDistanceToNow(new Date(device.lastSeenAt), { addSuffix: true })
                            : "Never"}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <ChevronRight className="h-4 w-4 text-muted-foreground opacity-40 group-hover:opacity-100 transition-opacity" />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Sheet open={!!selectedDevice} onOpenChange={(open) => !open && setSelectedId(null)}>
        <SheetContent className="flex w-full flex-col sm:max-w-xl">
          {selectedDevice && <DeviceActivityPanel device={selectedDevice} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}
