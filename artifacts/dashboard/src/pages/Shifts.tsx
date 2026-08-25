import React, { useState } from "react";
import {
  useListShifts,
  getListShiftsQueryKey,
  useCreateShift,
  useUpdateShift,
  useDeleteShift,
  type ShiftItem,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Clock4, Plus, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ViewToggle, useViewMode } from "@/components/ViewToggle";

const SHIFT_TYPES = [
  { value: "morning", label: "Morning" },
  { value: "evening", label: "Evening" },
  { value: "night", label: "Night" },
] as const;

function shiftBadge(type: string) {
  switch (type) {
    case "morning":
      return "bg-amber-500/15 text-amber-700 border-amber-500/20";
    case "evening":
      return "bg-sky-500/15 text-sky-700 border-sky-500/20";
    case "night":
      return "bg-indigo-500/15 text-indigo-700 border-indigo-500/20";
    default:
      return "bg-slate-500/15 text-slate-600 border-slate-500/20";
  }
}

export default function Shifts() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: shifts, isLoading } = useListShifts();

  const createShift = useCreateShift();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [shiftType, setShiftType] = useState("morning");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");
  const [viewMode, setViewMode] = useViewMode("shifts");

  const refetch = () =>
    queryClient.invalidateQueries({ queryKey: getListShiftsQueryKey() });

  const handleCreate = () => {
    if (!name.trim()) return;
    createShift.mutate(
      {
        data: {
          name: name.trim(),
          shiftType: shiftType as never,
          startTime,
          endTime,
        },
      },
      {
        onSuccess: () => {
          refetch();
          setName("");
          setShiftType("morning");
          setStartTime("09:00");
          setEndTime("17:00");
          setCreateOpen(false);
          toast({ title: "Shift created" });
        },
      },
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Shifts</h1>
          <p className="text-muted-foreground mt-1">
            Define work shifts. A device&apos;s assigned shift overrides the
            default work-start time when computing attendance.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle mode={viewMode} onChange={setViewMode} />
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="h-4 w-4" />
                New Shift
              </Button>
            </DialogTrigger>
            <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Shift</DialogTitle>
              <DialogDescription>
                Times use 24-hour HH:MM format in the device&apos;s local time.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="s-name">Name</Label>
                <Input
                  id="s-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Morning Shift"
                />
              </div>
              <div className="grid gap-2">
                <Label>Type</Label>
                <Select value={shiftType} onValueChange={setShiftType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SHIFT_TYPES.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="s-start">Start time</Label>
                  <Input
                    id="s-start"
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="s-end">End time</Label>
                  <Input
                    id="s-end"
                    type="time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                  />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleCreate}
                disabled={createShift.isPending || !name.trim()}
              >
                {createShift.isPending ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 space-y-4 animate-pulse">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 bg-muted rounded-md"></div>
              ))}
            </div>
          ) : viewMode === "table" ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Shift</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Start</TableHead>
                  <TableHead>End</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shifts?.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="h-32 text-center text-muted-foreground"
                    >
                      <div className="flex flex-col items-center justify-center">
                        <Clock4 className="h-8 w-8 mb-2 opacity-20" />
                        No shifts yet. Create one to get started.
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  shifts?.map((shift) => (
                    <ShiftRow key={shift.id} shift={shift} onChanged={refetch} />
                  ))
                )}
              </TableBody>
            </Table>
          ) : shifts?.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center p-4 text-center text-muted-foreground">
              <Clock4 className="mb-2 h-8 w-8 opacity-20" />
              No shifts yet. Create one to get started.
            </div>
          ) : (
            <div className="grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-3">
              {shifts?.map((shift) => (
                <ShiftCard key={shift.id} shift={shift} onChanged={refetch} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ShiftCard({
  shift,
  onChanged,
}: {
  shift: ShiftItem;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const updateShift = useUpdateShift();
  const deleteShift = useDeleteShift();

  const handleType = (shiftType: string) => {
    updateShift.mutate(
      { id: shift.id, data: { shiftType: shiftType as never } },
      { onSuccess: onChanged },
    );
  };

  const handleTime = (field: "startTime" | "endTime", value: string) => {
    if (!value || value === shift[field]) return;
    updateShift.mutate(
      { id: shift.id, data: { [field]: value } as never },
      { onSuccess: onChanged },
    );
  };

  const handleDelete = () => {
    if (!confirm(`Delete shift "${shift.name}"? This cannot be undone.`)) return;
    deleteShift.mutate(
      { id: shift.id },
      {
        onSuccess: () => {
          onChanged();
          toast({ title: "Shift deleted" });
        },
      },
    );
  };

  return (
    <Card className="shadow-sm">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Clock4 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <h3 className="truncate font-semibold" title={shift.name}>{shift.name}</h3>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-destructive"
            onClick={handleDelete}
            disabled={deleteShift.isPending}
            title="Delete shift"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
        <div className="mt-4 grid gap-4">
          <div>
            <Label className="text-xs text-muted-foreground">Type</Label>
            <Select value={shift.shiftType} onValueChange={handleType}>
              <SelectTrigger className={`mt-1 h-8 w-full ${shiftBadge(shift.shiftType)}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SHIFT_TYPES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-xs text-muted-foreground">Start</Label>
              <Input
                type="time"
                defaultValue={shift.startTime}
                onBlur={(e) => handleTime("startTime", e.target.value)}
                className="mt-1 h-8 w-full"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">End</Label>
              <Input
                type="time"
                defaultValue={shift.endTime}
                onBlur={(e) => handleTime("endTime", e.target.value)}
                className="mt-1 h-8 w-full"
              />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ShiftRow({
  shift,
  onChanged,
}: {
  shift: ShiftItem;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const updateShift = useUpdateShift();
  const deleteShift = useDeleteShift();

  const handleType = (shiftType: string) => {
    updateShift.mutate(
      { id: shift.id, data: { shiftType: shiftType as never } },
      { onSuccess: onChanged },
    );
  };

  const handleTime = (field: "startTime" | "endTime", value: string) => {
    if (!value || value === shift[field]) return;
    updateShift.mutate(
      { id: shift.id, data: { [field]: value } as never },
      { onSuccess: onChanged },
    );
  };

  const handleDelete = () => {
    if (!confirm(`Delete shift "${shift.name}"? This cannot be undone.`)) return;
    deleteShift.mutate(
      { id: shift.id },
      {
        onSuccess: () => {
          onChanged();
          toast({ title: "Shift deleted" });
        },
      },
    );
  };

  return (
    <TableRow>
      <TableCell className="font-medium">{shift.name}</TableCell>
      <TableCell>
        <Select value={shift.shiftType} onValueChange={handleType}>
          <SelectTrigger className={`w-32 h-8 ${shiftBadge(shift.shiftType)}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SHIFT_TYPES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <Input
          type="time"
          defaultValue={shift.startTime}
          onBlur={(e) => handleTime("startTime", e.target.value)}
          className="h-8 w-28"
        />
      </TableCell>
      <TableCell>
        <Input
          type="time"
          defaultValue={shift.endTime}
          onBlur={(e) => handleTime("endTime", e.target.value)}
          className="h-8 w-28"
        />
      </TableCell>
      <TableCell className="text-right">
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-destructive"
          onClick={handleDelete}
          disabled={deleteShift.isPending}
          title="Delete shift"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </TableCell>
    </TableRow>
  );
}
