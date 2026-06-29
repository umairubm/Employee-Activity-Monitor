import React, { useState } from "react";
import {
  useListLeaveRequests,
  getListLeaveRequestsQueryKey,
  useCreateLeaveRequest,
  useReviewLeaveRequest,
  useCancelLeaveRequest,
  useUpdateLeaveRequest,
  useDeleteLeaveRequest,
  useListLeaveBalances,
  getListLeaveBalancesQueryKey,
  useUpsertLeaveBalance,
  useListUsers,
  type LeaveRequestItem,
  type LeaveBalanceItem,
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
import { Textarea } from "@/components/ui/textarea";
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
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { CalendarOff, Plus, Trash2, Check, X, Ban, Pencil } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const LEAVE_TYPES = [
  { value: "annual", label: "Annual" },
  { value: "sick", label: "Sick" },
  { value: "casual", label: "Casual" },
  { value: "unpaid", label: "Unpaid" },
] as const;

function statusBadge(status: string) {
  switch (status) {
    case "approved":
      return "bg-emerald-500/15 text-emerald-700 border-emerald-500/20";
    case "rejected":
      return "bg-destructive/10 text-destructive border-destructive/20";
    case "cancelled":
      return "bg-slate-500/15 text-slate-600 border-slate-500/20";
    default:
      return "bg-amber-500/15 text-amber-700 border-amber-500/20";
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export default function Leave() {
  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Leave</h1>
        <p className="text-muted-foreground mt-1">
          Manage leave requests and per-user annual balances. Approving a request
          consumes balance and marks the days as on-leave in attendance.
        </p>
      </div>

      <Tabs defaultValue="requests">
        <TabsList>
          <TabsTrigger value="requests">Requests</TabsTrigger>
          <TabsTrigger value="balances">Balances</TabsTrigger>
        </TabsList>
        <TabsContent value="requests" className="mt-4">
          <RequestsTab />
        </TabsContent>
        <TabsContent value="balances" className="mt-4">
          <BalancesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function RequestsTab() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const { data: requests, isLoading } = useListLeaveRequests(
    statusFilter === "all" ? undefined : { status: statusFilter as never },
  );
  const { data: users } = useListUsers();

  const createReq = useCreateLeaveRequest();
  const [createOpen, setCreateOpen] = useState(false);
  const [userId, setUserId] = useState("");
  const [leaveType, setLeaveType] = useState("annual");
  const [startDate, setStartDate] = useState(today());
  const [endDate, setEndDate] = useState(today());
  const [reason, setReason] = useState("");

  const refetch = () =>
    queryClient.invalidateQueries({ queryKey: getListLeaveRequestsQueryKey() });

  const handleCreate = () => {
    if (!userId) return;
    createReq.mutate(
      {
        data: {
          userId,
          leaveType: leaveType as never,
          startDate,
          endDate,
          reason: reason.trim() || null,
        },
      },
      {
        onSuccess: () => {
          refetch();
          setUserId("");
          setLeaveType("annual");
          setStartDate(today());
          setEndDate(today());
          setReason("");
          setCreateOpen(false);
          toast({ title: "Leave request created" });
        },
        onError: (e) =>
          toast({
            title: "Could not create request",
            description: (e as Error).message,
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="h-4 w-4" />
              New Request
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Leave Request</DialogTitle>
              <DialogDescription>
                Business days (Mon&ndash;Fri) in the range are counted as leave
                days.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label>User</Label>
                <Select value={userId} onValueChange={setUserId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select user" />
                  </SelectTrigger>
                  <SelectContent>
                    {users?.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.username}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Type</Label>
                <Select value={leaveType} onValueChange={setLeaveType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LEAVE_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="l-start">Start date</Label>
                  <Input
                    id="l-start"
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="l-end">End date</Label>
                  <Input
                    id="l-end"
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="l-reason">Reason (optional)</Label>
                <Textarea
                  id="l-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleCreate}
                disabled={createReq.isPending || !userId}
              >
                {createReq.isPending ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 space-y-4 animate-pulse">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 bg-muted rounded-md"></div>
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Dates</TableHead>
                  <TableHead>Days</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests?.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="h-32 text-center text-muted-foreground"
                    >
                      <div className="flex flex-col items-center justify-center">
                        <CalendarOff className="h-8 w-8 mb-2 opacity-20" />
                        No leave requests.
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  requests?.map((req) => (
                    <RequestRow key={req.id} req={req} onChanged={refetch} />
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RequestRow({
  req,
  onChanged,
}: {
  req: LeaveRequestItem;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const review = useReviewLeaveRequest();
  const cancelReq = useCancelLeaveRequest();
  const updateReq = useUpdateLeaveRequest();
  const deleteReq = useDeleteLeaveRequest();

  const [editOpen, setEditOpen] = useState(false);
  const [editType, setEditType] = useState<string>(req.leaveType);
  const [editStart, setEditStart] = useState(req.startDate);
  const [editEnd, setEditEnd] = useState(req.endDate);
  const [editReason, setEditReason] = useState(req.reason ?? "");

  const openEdit = () => {
    setEditType(req.leaveType);
    setEditStart(req.startDate);
    setEditEnd(req.endDate);
    setEditReason(req.reason ?? "");
    setEditOpen(true);
  };

  const handleSaveEdit = () => {
    updateReq.mutate(
      {
        id: req.id,
        data: {
          leaveType: editType as never,
          startDate: editStart,
          endDate: editEnd,
          reason: editReason.trim() || null,
        },
      },
      {
        onSuccess: () => {
          onChanged();
          setEditOpen(false);
          toast({ title: "Leave request updated" });
        },
        onError: (e) =>
          toast({
            title: "Update failed",
            description: (e as Error).message,
            variant: "destructive",
          }),
      },
    );
  };

  const handleCancel = () => {
    if (!confirm("Cancel this pending leave request?")) return;
    cancelReq.mutate(
      { id: req.id },
      {
        onSuccess: () => {
          onChanged();
          toast({ title: "Leave request cancelled" });
        },
        onError: (e) =>
          toast({
            title: "Cancel failed",
            description: (e as Error).message,
            variant: "destructive",
          }),
      },
    );
  };

  const handleReview = (status: "approved" | "rejected") => {
    review.mutate(
      { id: req.id, data: { status } },
      {
        onSuccess: () => {
          onChanged();
          toast({
            title: status === "approved" ? "Request approved" : "Request rejected",
          });
        },
        onError: (e) =>
          toast({
            title: "Review failed",
            description: (e as Error).message,
            variant: "destructive",
          }),
      },
    );
  };

  const handleDelete = () => {
    if (!confirm("Delete this leave request? Approved days are refunded.")) return;
    deleteReq.mutate(
      { id: req.id },
      {
        onSuccess: () => {
          onChanged();
          toast({ title: "Leave request deleted" });
        },
      },
    );
  };

  return (
    <TableRow>
      <TableCell className="font-medium">
        {req.username ?? req.userId.slice(0, 8)}
      </TableCell>
      <TableCell className="capitalize">{req.leaveType}</TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {req.startDate} &rarr; {req.endDate}
      </TableCell>
      <TableCell>{req.days}</TableCell>
      <TableCell>
        <Badge variant="outline" className={statusBadge(req.status)}>
          {req.status}
        </Badge>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          {req.status === "pending" && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-emerald-600"
                onClick={() => handleReview("approved")}
                disabled={review.isPending}
                title="Approve"
              >
                <Check className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                onClick={() => handleReview("rejected")}
                disabled={review.isPending}
                title="Reject"
              >
                <X className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                onClick={openEdit}
                disabled={updateReq.isPending}
                title="Edit"
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                onClick={handleCancel}
                disabled={cancelReq.isPending}
                title="Cancel request"
              >
                <Ban className="h-4 w-4" />
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            onClick={handleDelete}
            disabled={deleteReq.isPending}
            title="Delete"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>

        <Dialog open={editOpen} onOpenChange={setEditOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit Leave Request</DialogTitle>
              <DialogDescription>
                Only pending requests can be edited. Business days
                (Mon&ndash;Fri) in the range are counted as leave days.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4 text-left">
              <div className="grid gap-2">
                <Label>Type</Label>
                <Select value={editType} onValueChange={setEditType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LEAVE_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor={`e-start-${req.id}`}>Start date</Label>
                  <Input
                    id={`e-start-${req.id}`}
                    type="date"
                    value={editStart}
                    onChange={(e) => setEditStart(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor={`e-end-${req.id}`}>End date</Label>
                  <Input
                    id={`e-end-${req.id}`}
                    type="date"
                    value={editEnd}
                    onChange={(e) => setEditEnd(e.target.value)}
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor={`e-reason-${req.id}`}>Reason (optional)</Label>
                <Textarea
                  id={`e-reason-${req.id}`}
                  value={editReason}
                  onChange={(e) => setEditReason(e.target.value)}
                  rows={2}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleSaveEdit}
                disabled={updateReq.isPending || editStart > editEnd}
              >
                {updateReq.isPending ? "Saving..." : "Save changes"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </TableCell>
    </TableRow>
  );
}

function BalancesTab() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const year = new Date().getFullYear();
  const { data: balances, isLoading } = useListLeaveBalances({ year });
  const { data: users } = useListUsers();

  const upsert = useUpsertLeaveBalance();
  const [createOpen, setCreateOpen] = useState(false);
  const [userId, setUserId] = useState("");
  const [leaveType, setLeaveType] = useState("annual");
  const [allocatedDays, setAllocatedDays] = useState("20");

  const refetch = () =>
    queryClient.invalidateQueries({ queryKey: getListLeaveBalancesQueryKey() });

  const handleUpsert = () => {
    if (!userId) return;
    const allocated = parseInt(allocatedDays, 10);
    upsert.mutate(
      {
        data: {
          userId,
          year,
          leaveType: leaveType as never,
          allocatedDays: Number.isFinite(allocated) ? allocated : 0,
        },
      },
      {
        onSuccess: () => {
          refetch();
          setUserId("");
          setLeaveType("annual");
          setAllocatedDays("20");
          setCreateOpen(false);
          toast({ title: "Balance saved" });
        },
        onError: (e) =>
          toast({
            title: "Could not save balance",
            description: (e as Error).message,
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Allocations for {year}. Saving an existing user/type updates the
          allocation and preserves used days.
        </p>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="h-4 w-4" />
              Set Allocation
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Set Leave Allocation</DialogTitle>
              <DialogDescription>
                Allocate days for {year} for a given user and leave type.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label>User</Label>
                <Select value={userId} onValueChange={setUserId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select user" />
                  </SelectTrigger>
                  <SelectContent>
                    {users?.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.username}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Type</Label>
                <Select value={leaveType} onValueChange={setLeaveType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LEAVE_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="b-days">Allocated days</Label>
                <Input
                  id="b-days"
                  type="number"
                  min="0"
                  value={allocatedDays}
                  onChange={(e) => setAllocatedDays(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleUpsert}
                disabled={upsert.isPending || !userId}
              >
                {upsert.isPending ? "Saving..." : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 space-y-4 animate-pulse">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 bg-muted rounded-md"></div>
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Allocated</TableHead>
                  <TableHead>Used</TableHead>
                  <TableHead>Remaining</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {balances?.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="h-32 text-center text-muted-foreground"
                    >
                      <div className="flex flex-col items-center justify-center">
                        <CalendarOff className="h-8 w-8 mb-2 opacity-20" />
                        No balances set for {year}.
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  balances?.map((bal: LeaveBalanceItem) => (
                    <TableRow key={bal.id}>
                      <TableCell className="font-medium">
                        {bal.username ?? bal.userId.slice(0, 8)}
                      </TableCell>
                      <TableCell className="capitalize">{bal.leaveType}</TableCell>
                      <TableCell>{bal.allocatedDays}</TableCell>
                      <TableCell>{bal.usedDays}</TableCell>
                      <TableCell>
                        <span
                          className={
                            bal.remainingDays < 0
                              ? "text-destructive font-medium"
                              : ""
                          }
                        >
                          {bal.remainingDays}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
