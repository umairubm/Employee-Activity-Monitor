import React, { useMemo, useState } from "react";
import {
  useListDevices,
  getListDevicesQueryKey,
  getListTokensQueryKey,
  getListTokenGroupsQueryKey,
  useSetDeviceGroup,
  useSetDeviceRegion,
  useRenameDeviceGroup,
  useListTokenGroups,
  useListTokenRegions,
  useDeleteDevice,
  useSetDeviceAssignment,
} from "@workspace/api-client-react";
import type { DeviceItem } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  MonitorSmartphone,
  Search,
  CheckCircle2,
  XCircle,
  Clock,
  ShieldCheck,
  FolderPen,
  FolderSync,
  AlertTriangle,
  Trash2,
  UserPlus,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { ALL_GROUPS as ALL } from "@/hooks/use-group-filter";
import { AgentUpdateDialog } from "@/components/AgentUpdateDialog";
import { ViewToggle, useViewMode } from "@/components/ViewToggle";
import { RegionMultiSelect } from "@/components/RegionMultiSelect";
import { AssignDeviceDialog } from "@/components/AssignDeviceDialog";
import { useAuth } from "@/lib/auth-context";

type DeviceSortField =
  | "systemName"
  | "employee"
  | "group"
  | "region"
  | "label"
  | "os"
  | "status"
  | "agentVersion"
  | "lastSeen";

type SortDirection = "asc" | "desc";
type StatusFilter = "all" | "online" | "offline";

const SORT_FIELD_LABELS: Record<DeviceSortField, string> = {
  systemName: "System Name",
  employee: "Employee",
  group: "Group",
  region: "Region",
  label: "Label",
  os: "OS",
  status: "Status",
  agentVersion: "Agent Version",
  lastSeen: "Last Seen",
};

function getDeviceSortValue(device: DeviceItem, field: DeviceSortField): string | number {
  switch (field) {
    case "systemName":
      return device.systemName;
    case "employee":
      return device.assignedUsername || device.tokenEmployeeId || "";
    case "group":
      return device.deviceGroup;
    case "region":
      return device.region ?? device.tokenRegion ?? "";
    case "label":
      return device.tokenLabel || "";
    case "os":
      return device.osType;
    case "status":
      return device.online ? "Online" : "Offline";
    case "agentVersion":
      return device.agentVersion || "";
    case "lastSeen":
      return device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0;
  }
}

function compareDevices(
  a: DeviceItem,
  b: DeviceItem,
  field: DeviceSortField,
  direction: SortDirection,
) {
  const aValue = getDeviceSortValue(a, field);
  const bValue = getDeviceSortValue(b, field);
  const result =
    typeof aValue === "number" && typeof bValue === "number"
      ? aValue - bValue
      : String(aValue).localeCompare(String(bValue), undefined, {
          numeric: true,
          sensitivity: "base",
        });

  if (result !== 0) {
    return direction === "asc" ? result : -result;
  }

  // Keep ties deterministic even when two devices share the same displayed value.
  return a.id.localeCompare(b.id);
}

function SortableHeader({
  field,
  sortField,
  sortDirection,
  onSort,
  className = "",
}: {
  field: DeviceSortField;
  sortField: DeviceSortField | null;
  sortDirection: SortDirection;
  onSort: (field: DeviceSortField) => void;
  className?: string;
}) {
  const active = sortField === field;
  const Icon = active
    ? sortDirection === "asc"
      ? ArrowUp
      : ArrowDown
    : ArrowUpDown;

  return (
    <TableHead
      className={className}
      aria-sort={active ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        className="inline-flex items-center gap-1.5 whitespace-nowrap font-medium hover:text-foreground"
        aria-label={`Sort by ${SORT_FIELD_LABELS[field]}`}
      >
        {SORT_FIELD_LABELS[field]}
        <Icon className={`h-3.5 w-3.5 ${active ? "text-foreground" : "text-muted-foreground/60"}`} />
      </button>
    </TableHead>
  );
}

export default function Devices() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  // Poll so device names/status stay in sync with the latest agent reports
  // (e.g. a hostname change) without requiring a manual page reload.
  const { data: devices, isLoading } = useListDevices({
    query: { queryKey: getListDevicesQueryKey(), refetchInterval: 30_000 },
  });
  // App-wide group taxonomy (union of distinct groups on devices + tokens),
  // so the filter/rename/assign controls list every group that exists — not
  // only groups that already have a device.
  const { data: tokenGroups } = useListTokenGroups();
  const { data: tokenRegions } = useListTokenRegions();
  const setGroup = useSetDeviceGroup();
  const setRegion = useSetDeviceRegion();
  const renameGroup = useRenameDeviceGroup();
  const deleteDevice = useDeleteDevice();
  const [assignmentDevice, setAssignmentDevice] = useState<DeviceItem | null>(null);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useViewMode("devices");
  const [sortField, setSortField] = useState<DeviceSortField | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [sortOrder, setSortOrder] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => {
    const requested = new URLSearchParams(window.location.search).get("status");
    return requested === "online" || requested === "offline" ? requested : "all";
  });
  // The Devices page always starts on "All groups" (local state, not the
  // shared persisted filter) so the full fleet is visible by default.
  const [groupFilter, setGroupFilter] = useState<string>(ALL);

  const [editId, setEditId] = useState<string | null>(null);
  const [editGroup, setEditGroup] = useState("");
  const [editRegion, setEditRegion] = useState("");
  // What the region field held when the dialog opened, so we only issue the
  // region mutation when the admin actually changed it.
  const [initialRegion, setInitialRegion] = useState("");
  const [removeDevice, setRemoveDevice] = useState<DeviceItem | null>(null);
  const [removeConfirmation, setRemoveConfirmation] = useState("");

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameFrom, setRenameFrom] = useState("");
  const [renameTo, setRenameTo] = useState("");

  const groups = useMemo(() => {
    const set = new Set<string>();
    devices?.forEach((d) => set.add(d.deviceGroup));
    tokenGroups?.forEach((g) => set.add(g));
    return Array.from(set).sort();
  }, [devices, tokenGroups]);

  const canRemoveDevices = user?.role === "company_admin" || user?.role === "manager";

  const openRemoveDialog = (device: DeviceItem) => {
    setRemoveDevice(device);
    setRemoveConfirmation("");
  };

  const handleRemoveDevice = () => {
    if (!removeDevice || removeConfirmation !== "REMOVE DEVICE") return;
    const removedSystemName = removeDevice.systemName;
    deleteDevice.mutate(
      { id: removeDevice.id, data: { confirmation: removeConfirmation } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListDevicesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListTokensQueryKey() });
          setRemoveDevice(null);
          setRemoveConfirmation("");
          toast({
            title: "Device removed",
            description: `${removedSystemName} and its device history were permanently removed.`,
          });
        },
        onError: (error: any) => {
          toast({
            title: "Failed to remove device",
            description: error.message,
            variant: "destructive",
          });
        },
      },
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 bg-muted rounded-md mb-6"></div>
        <div className="h-[400px] bg-muted rounded-xl"></div>
      </div>
    );
  }

  const searchTerm = search.trim().toLocaleLowerCase();
  const filteredDevices = devices?.filter((d) => {
    const searchableValues = [
      d.systemName,
      d.hardwareHash,
      d.assignedUsername,
      d.tokenEmployeeId,
      d.tokenLabel,
      d.deviceGroup,
      d.region ?? d.tokenRegion,
      d.osType,
    ];
    const matchesSearch =
      searchTerm === "" ||
      searchableValues.some((value) =>
        value?.toLocaleLowerCase().includes(searchTerm),
      );
    const matchesGroup = groupFilter === ALL || d.deviceGroup === groupFilter;
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "online" ? d.online : !d.online);
    return matchesSearch && matchesGroup && matchesStatus;
  });

  const handleSort = (field: DeviceSortField) => {
    const nextDirection =
      sortField === field && sortDirection === "asc" ? "desc" : "asc";
    const nextOrder = [...(filteredDevices ?? [])]
      .sort((a, b) => compareDevices(a, b, field, nextDirection))
      .map((device) => device.id);

    setSortField(field);
    setSortDirection(nextDirection);
    setSortOrder(nextOrder);
  };

  const sortPositions = new Map(sortOrder.map((id, index) => [id, index]));
  const sortedDevices = [...(filteredDevices ?? [])].sort((a, b) => {
    if (!sortField) return 0;

    const aPosition = sortPositions.get(a.id);
    const bPosition = sortPositions.get(b.id);
    if (aPosition !== undefined && bPosition !== undefined) {
      return aPosition - bPosition;
    }
    if (aPosition !== undefined) return -1;
    if (bPosition !== undefined) return 1;
    return a.id.localeCompare(b.id);
  });

  const openEdit = (id: string, currentGroup: string, currentRegion: string) => {
    setEditId(id);
    setEditGroup(currentGroup);
    setEditRegion(currentRegion);
    setInitialRegion(currentRegion);
  };

  const saveEdit = async () => {
    if (!editId) return;
    const group = editGroup.trim();
    if (!group) return;
    const region = editRegion.trim();
    try {
      await setGroup.mutateAsync({ id: editId, data: { deviceGroup: group } });
      if (region !== initialRegion.trim()) {
        // Empty input clears the override so the device inherits its token's region.
        await setRegion.mutateAsync({ id: editId, data: { region: region || null } });
      }
      queryClient.invalidateQueries({ queryKey: getListDevicesQueryKey() });
      toast({ title: "Device updated" });
      setEditId(null);
    } catch (error: any) {
      queryClient.invalidateQueries({ queryKey: getListDevicesQueryKey() });
      toast({ title: "Failed to update device", description: error.message, variant: "destructive" });
    }
  };

  const openRename = () => {
    setRenameFrom(groupFilter !== ALL ? groupFilter : groups[0] ?? "");
    setRenameTo("");
    setRenameOpen(true);
  };

  const saveRename = () => {
    const from = renameFrom.trim();
    const to = renameTo.trim();
    if (!from || !to) return;
    renameGroup.mutate(
      { data: { from, to } },
      {
        onSuccess: (result) => {
          queryClient.invalidateQueries({ queryKey: getListDevicesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListTokensQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListTokenGroupsQueryKey() });
          if (groupFilter === from) setGroupFilter(to);
          toast({
            title: "Group renamed",
            description: `${result.renamed} device(s) and ${result.tokensRenamed} token(s) updated.`,
          });
          setRenameOpen(false);
        },
        onError: (error: any) => {
          toast({ title: "Failed to rename group", description: error.message, variant: "destructive" });
        },
      },
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Devices</h1>
          <p className="text-muted-foreground mt-1">Monitor enrolled company devices.</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
          <AgentUpdateDialog devices={devices ?? []} />
          <Button variant="outline" className="gap-2" onClick={openRename} disabled={groups.length === 0}>
            <FolderSync className="h-4 w-4" /> Rename group
          </Button>
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
          <Select
            value={statusFilter}
            onValueChange={(value) => setStatusFilter(value as StatusFilter)}
          >
            <SelectTrigger className="w-full sm:w-36">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="online">Online</SelectItem>
              <SelectItem value="offline">Offline</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search name, device, label..."
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <ViewToggle mode={viewMode} onChange={setViewMode} label="Device view" />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {viewMode === "table" ? (
            <div className="overflow-x-auto pb-2">
            <Table className="min-w-[1180px]">
            <TableHeader>
              <TableRow>
                <SortableHeader
                  field="systemName"
                  sortField={sortField}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                  className="sticky left-0 z-20 w-[240px] min-w-[240px] bg-card"
                />
                <SortableHeader field="employee" sortField={sortField} sortDirection={sortDirection} onSort={handleSort} />
                <SortableHeader field="group" sortField={sortField} sortDirection={sortDirection} onSort={handleSort} />
                <SortableHeader field="region" sortField={sortField} sortDirection={sortDirection} onSort={handleSort} />
                <SortableHeader field="label" sortField={sortField} sortDirection={sortDirection} onSort={handleSort} />
                <SortableHeader field="os" sortField={sortField} sortDirection={sortDirection} onSort={handleSort} />
                <SortableHeader field="status" sortField={sortField} sortDirection={sortDirection} onSort={handleSort} />
                <SortableHeader field="agentVersion" sortField={sortField} sortDirection={sortDirection} onSort={handleSort} />
                <TableHead>Consent</TableHead>
                <SortableHeader field="lastSeen" sortField={sortField} sortDirection={sortDirection} onSort={handleSort} />
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredDevices?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={11} className="h-32 text-center text-muted-foreground">
                    No devices found.
                  </TableCell>
                </TableRow>
              ) : (
                sortedDevices.map((device) => (
                  <TableRow key={device.id} className="group">
                    <TableCell className="sticky left-0 z-10 w-[240px] min-w-[240px] max-w-[240px] bg-card font-medium transition-colors group-hover:bg-muted">
                      <div className="flex items-center gap-2">
                        <MonitorSmartphone className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate" title={device.systemName}>{device.systemName}</span>
                        {device.isLocked && <Badge variant="destructive" className="ml-2 text-[10px]">Locked</Badge>}
                        {(device.alertCount ?? 0) > 0 && (
                          <Badge variant="destructive" className="ml-2 gap-1 text-[10px]" title="Unacknowledged hardware changes">
                            <AlertTriangle className="h-3 w-3" />
                            {device.alertCount}
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground font-mono mt-1">{device.hardwareHash.substring(0, 8)}...</div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {device.assignedUsername || device.tokenEmployeeId ? (
                        <div>
                          <span className="font-medium">{device.assignedUsername || device.tokenEmployeeId}</span>
                          {device.assignedUsername && device.tokenEmployeeId && (
                            <div className="text-xs text-muted-foreground">{device.tokenEmployeeId}</div>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <button
                        onClick={() => openEdit(device.id, device.deviceGroup, device.region ?? device.tokenRegion ?? "")}
                        className="inline-flex items-center gap-1.5 text-sm hover:text-primary transition-colors"
                        title="Change group"
                      >
                        <Badge variant="secondary" className="font-normal">{device.deviceGroup}</Badge>
                        <FolderPen className="h-3.5 w-3.5 opacity-0 group-hover:opacity-60" />
                      </button>
                    </TableCell>
                    <TableCell className="text-sm">
                      <button
                        onClick={() => openEdit(device.id, device.deviceGroup, device.region ?? device.tokenRegion ?? "")}
                        className="inline-flex items-center gap-1.5 text-sm hover:text-primary transition-colors"
                        title="Change region"
                      >
                        {device.region ?? device.tokenRegion ? (
                          <Badge variant="outline" className="font-normal">{device.region ?? device.tokenRegion}</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                        <FolderPen className="h-3.5 w-3.5 opacity-0 group-hover:opacity-60" />
                      </button>
                    </TableCell>
                    <TableCell className="text-sm">
                      {device.tokenLabel ? (
                        device.tokenLabel
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
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
                    <TableCell>
                      {device.agentVersion ? (
                        <Badge variant="outline" className="font-mono text-xs">
                          v{device.agentVersion}
                        </Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">Unknown</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {device.consentAcknowledgedAt ? (
                        <div className="flex items-center gap-1.5 text-sm" title={`Acknowledged by ${device.consentName}`}>
                          <ShieldCheck className="h-4 w-4 text-primary" />
                          <span>Acknowledged</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-sm">Pending</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      <div className="flex items-center gap-1.5">
                        <Clock className="h-3.5 w-3.5" />
                        {device.lastSeenAt ? formatDistanceToNow(new Date(device.lastSeenAt), { addSuffix: true }) : "Never"}
                      </div>
                    </TableCell>
                     <TableCell className="text-right">
                       <div className="flex justify-end gap-2">
                       <Link href={`/devices/${device.id}`} className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2 border border-input bg-background shadow-sm">
                        Details
                      </Link>
                       {canRemoveDevices && (
                         <Button
                           type="button"
                           variant="outline"
                           className="h-9 gap-1.5 px-3"
                           onClick={() => setAssignmentDevice(device)}
                           aria-label={`Assign ${device.systemName} to an existing user`}
                         >
                           <UserPlus className="h-4 w-4" />
                           Assign user
                         </Button>
                       )}
                       {canRemoveDevices && (
                         <Button
                           type="button"
                           variant="outline"
                           className="h-9 border-destructive/40 px-3 text-destructive hover:bg-destructive/10 hover:text-destructive"
                           onClick={() => openRemoveDialog(device)}
                           aria-label={`Remove ${device.systemName}`}
                         >
                           <Trash2 className="mr-1.5 h-4 w-4" />
                           Remove
                         </Button>
                       )}
                       </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
            </Table>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 xl:grid-cols-3">
              {filteredDevices?.length === 0 ? (
                <div className="col-span-full flex min-h-32 items-center justify-center text-center text-muted-foreground">
                  No devices found.
                </div>
              ) : (
                sortedDevices.map((device) => (
                  <div key={device.id} className="rounded-lg border bg-card p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <MonitorSmartphone className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <h3 className="truncate font-semibold" title={device.systemName}>
                            {device.systemName}
                          </h3>
                        </div>
                        <p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={device.hardwareHash}>
                          {device.hardwareHash}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-1">
                        {device.isLocked && <Badge variant="destructive">Locked</Badge>}
                        {(device.alertCount ?? 0) > 0 && (
                          <Badge variant="destructive" className="gap-1" title="Unacknowledged hardware changes">
                            <AlertTriangle className="h-3 w-3" />
                            {device.alertCount}
                          </Badge>
                        )}
                        <Badge variant={device.online ? "default" : "secondary"} className={device.online ? "bg-emerald-600 hover:bg-emerald-600" : ""}>
                          {device.online ? "Online" : "Offline"}
                        </Badge>
                      </div>
                    </div>

                    <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                      <div>
                        <p className="text-xs text-muted-foreground">Username</p>
                        <p className="truncate font-medium" title={device.assignedUsername || undefined}>
                          {device.assignedUsername || "—"}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Employee ID</p>
                        <p className="truncate font-medium" title={device.tokenEmployeeId || undefined}>
                          {device.tokenEmployeeId || "—"}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">OS</p>
                        <p className="capitalize">{device.osType}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Group</p>
                        <button
                          type="button"
                          onClick={() => openEdit(device.id, device.deviceGroup, device.region ?? device.tokenRegion ?? "")}
                          className="inline-flex max-w-full items-center gap-1.5 text-left hover:text-primary"
                          title="Change group"
                        >
                          <Badge variant="secondary" className="max-w-full truncate font-normal">{device.deviceGroup}</Badge>
                          <FolderPen className="h-3.5 w-3.5 shrink-0 opacity-60" />
                        </button>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Region</p>
                        <button
                          type="button"
                          onClick={() => openEdit(device.id, device.deviceGroup, device.region ?? device.tokenRegion ?? "")}
                          className="inline-flex max-w-full items-center gap-1.5 text-left hover:text-primary"
                          title="Change region"
                        >
                          <span className="truncate">{device.region ?? device.tokenRegion ?? "—"}</span>
                          <FolderPen className="h-3.5 w-3.5 shrink-0 opacity-60" />
                        </button>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Label</p>
                        <p className="truncate" title={device.tokenLabel || undefined}>{device.tokenLabel || "—"}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Agent version</p>
                        <p>{device.agentVersion ? `v${device.agentVersion}` : "Unknown"}</p>
                      </div>
                    </div>

                    <div className="mt-4 flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1.5" title={device.consentName ? `Acknowledged by ${device.consentName}` : undefined}>
                        <ShieldCheck className="h-3.5 w-3.5 text-primary" />
                        {device.consentAcknowledgedAt ? "Acknowledged" : "Consent pending"}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <Clock className="h-3.5 w-3.5" />
                        {device.lastSeenAt ? formatDistanceToNow(new Date(device.lastSeenAt), { addSuffix: true }) : "Never seen"}
                      </span>
                    </div>
                     <div className="mt-3 flex gap-2">
                       <Link
                         href={`/devices/${device.id}`}
                         className="inline-flex h-9 flex-1 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                       >
                         View Details
                       </Link>
                       {canRemoveDevices && (
                         <Button
                           type="button"
                           variant="outline"
                           className="h-9 border-primary/40 px-3 text-primary hover:bg-primary/10"
                           onClick={() => setAssignmentDevice(device)}
                           aria-label={`Assign ${device.systemName} to an existing user`}
                         >
                           <UserPlus className="h-4 w-4" />
                           <span className="sr-only">Assign user</span>
                         </Button>
                       )}
                       {canRemoveDevices && (
                         <Button
                           type="button"
                           variant="outline"
                           className="h-9 border-destructive/40 px-3 text-destructive hover:bg-destructive/10 hover:text-destructive"
                           onClick={() => openRemoveDialog(device)}
                           aria-label={`Remove ${device.systemName}`}
                         >
                           <Trash2 className="h-4 w-4" />
                           <span className="sr-only">Remove</span>
                         </Button>
                       )}
                     </div>
                  </div>
                ))
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {assignmentDevice && (
        <AssignDeviceDialog
          deviceId={assignmentDevice.id}
          deviceLabel={assignmentDevice.systemName}
          currentUserId={assignmentDevice.assignedUserId}
          open={!!assignmentDevice}
          onOpenChange={(open) => {
            if (!open) setAssignmentDevice(null);
          }}
        />
      )}

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Group</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="rename-from">Existing group</Label>
              <Select value={renameFrom} onValueChange={setRenameFrom}>
                <SelectTrigger id="rename-from">
                  <SelectValue placeholder="Select a group" />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((g) => (
                    <SelectItem key={g} value={g}>{g}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="rename-to">New name</Label>
              <Input
                id="rename-to"
                value={renameTo}
                onChange={(e) => setRenameTo(e.target.value)}
                placeholder="e.g. Platform"
                onKeyDown={(e) => e.key === "Enter" && saveRename()}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Renames the group on every device currently assigned to it.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>Cancel</Button>
            <Button onClick={saveRename} disabled={renameGroup.isPending || !renameFrom.trim() || !renameTo.trim()}>
              {renameGroup.isPending ? "Renaming..." : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editId} onOpenChange={(open) => !open && setEditId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Device</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="group">Group name</Label>
              <Input
                id="group"
                value={editGroup}
                onChange={(e) => setEditGroup(e.target.value)}
                placeholder="e.g. Engineering"
                list="device-groups"
                onKeyDown={(e) => e.key === "Enter" && saveEdit()}
              />
              <datalist id="device-groups">
                {groups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </div>
            <div className="space-y-2">
              <Label htmlFor="region">Region</Label>
              <RegionMultiSelect
                id="region"
                value={editRegion}
                options={tokenRegions}
                onChange={setEditRegion}
                placeholder="Inherit token region"
              />
              <p className="text-xs text-muted-foreground">
                Applies to this device only — the enrollment token and other devices
                keep their region. Leave empty to inherit the token's region.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditId(null)}>Cancel</Button>
            <Button onClick={saveEdit} disabled={setGroup.isPending || setRegion.isPending || !editGroup.trim()}>
              {setGroup.isPending || setRegion.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!removeDevice}
        onOpenChange={(open) => {
          if (!open && !deleteDevice.isPending) {
            setRemoveDevice(null);
            setRemoveConfirmation("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {removeDevice?.systemName}?</DialogTitle>
            <DialogDescription>
              This permanently removes the device and its activity history,
              screenshots, commands, and alerts. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="devices-remove-confirmation">
              Type <span className="font-mono font-semibold">REMOVE DEVICE</span> to continue
            </Label>
            <Input
              id="devices-remove-confirmation"
              value={removeConfirmation}
              onChange={(event) => setRemoveConfirmation(event.target.value)}
              placeholder="REMOVE DEVICE"
              autoComplete="off"
              onKeyDown={(event) => {
                if (event.key === "Enter") handleRemoveDevice();
              }}
            />
            {deleteDevice.isPending && (
              <p className="text-sm text-muted-foreground" role="status">
                Securely deleting stored screenshots. Devices with long histories may take a moment.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setRemoveDevice(null);
                setRemoveConfirmation("");
              }}
              disabled={deleteDevice.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleRemoveDevice}
              disabled={deleteDevice.isPending || removeConfirmation !== "REMOVE DEVICE"}
            >
              {deleteDevice.isPending ? "Removing..." : "Permanently remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
