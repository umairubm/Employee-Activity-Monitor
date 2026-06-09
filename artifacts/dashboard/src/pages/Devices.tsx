import React, { useMemo, useState } from "react";
import {
  useListDevices,
  getListDevicesQueryKey,
  useSetDeviceGroup,
  useRenameDeviceGroup,
} from "@workspace/api-client-react";
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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { MonitorSmartphone, Search, CheckCircle2, XCircle, Clock, ShieldCheck, FolderPen, FolderSync } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";

const ALL = "__all__";

export default function Devices() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: devices, isLoading } = useListDevices();
  const setGroup = useSetDeviceGroup();
  const renameGroup = useRenameDeviceGroup();
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState<string>(ALL);

  const [editId, setEditId] = useState<string | null>(null);
  const [editGroup, setEditGroup] = useState("");

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameFrom, setRenameFrom] = useState("");
  const [renameTo, setRenameTo] = useState("");

  const groups = useMemo(() => {
    const set = new Set<string>();
    devices?.forEach((d) => set.add(d.deviceGroup));
    return Array.from(set).sort();
  }, [devices]);

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 bg-muted rounded-md mb-6"></div>
        <div className="h-[400px] bg-muted rounded-xl"></div>
      </div>
    );
  }

  const filteredDevices = devices?.filter((d) => {
    const matchesSearch =
      d.systemName.toLowerCase().includes(search.toLowerCase()) ||
      d.hardwareHash.toLowerCase().includes(search.toLowerCase());
    const matchesGroup = groupFilter === ALL || d.deviceGroup === groupFilter;
    return matchesSearch && matchesGroup;
  });

  const openEdit = (id: string, current: string) => {
    setEditId(id);
    setEditGroup(current);
  };

  const saveGroup = () => {
    if (!editId) return;
    const value = editGroup.trim();
    if (!value) return;
    setGroup.mutate(
      { id: editId, data: { deviceGroup: value } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListDevicesQueryKey() });
          toast({ title: "Group updated" });
          setEditId(null);
        },
        onError: (error: any) => {
          toast({ title: "Failed to update group", description: error.message, variant: "destructive" });
        },
      },
    );
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
          if (groupFilter === from) setGroupFilter(to);
          toast({ title: "Group renamed", description: `${result.renamed} device(s) updated.` });
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
          <div className="relative w-full sm:w-72">
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>System Name</TableHead>
                <TableHead>Group</TableHead>
                <TableHead>OS</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Consent</TableHead>
                <TableHead>Last Seen</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredDevices?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                    No devices found.
                  </TableCell>
                </TableRow>
              ) : (
                filteredDevices?.map((device) => (
                  <TableRow key={device.id} className="group">
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <MonitorSmartphone className="h-4 w-4 text-muted-foreground" />
                        {device.systemName}
                        {device.isLocked && <Badge variant="destructive" className="ml-2 text-[10px]">Locked</Badge>}
                      </div>
                      <div className="text-xs text-muted-foreground font-mono mt-1">{device.hardwareHash.substring(0, 8)}...</div>
                    </TableCell>
                    <TableCell>
                      <button
                        onClick={() => openEdit(device.id, device.deviceGroup)}
                        className="inline-flex items-center gap-1.5 text-sm hover:text-primary transition-colors"
                        title="Change group"
                      >
                        <Badge variant="secondary" className="font-normal">{device.deviceGroup}</Badge>
                        <FolderPen className="h-3.5 w-3.5 opacity-0 group-hover:opacity-60" />
                      </button>
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
                      <Link href={`/devices/${device.id}`} className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2 border border-input bg-background shadow-sm">
                        Details
                      </Link>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

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
            <DialogTitle>Assign Group</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-2">
            <Label htmlFor="group">Group name</Label>
            <Input
              id="group"
              value={editGroup}
              onChange={(e) => setEditGroup(e.target.value)}
              placeholder="e.g. Engineering"
              list="device-groups"
              onKeyDown={(e) => e.key === "Enter" && saveGroup()}
            />
            <datalist id="device-groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditId(null)}>Cancel</Button>
            <Button onClick={saveGroup} disabled={setGroup.isPending || !editGroup.trim()}>
              {setGroup.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
