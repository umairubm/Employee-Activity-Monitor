import React, { useMemo, useState } from "react";
import {
  useGetAttendanceReport,
  getGetAttendanceReportQueryKey,
  useGetAttendanceSettings,
  getGetAttendanceSettingsQueryKey,
  useUpdateAttendanceSettings,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { CalendarCheck, Settings2, Clock } from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";

function todayStr(): string {
  const d = new Date();
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

export default function Attendance() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [date, setDate] = useState(todayStr());

  const reportParams = { date };
  const { data: report, isLoading } = useGetAttendanceReport(reportParams, {
    query: { queryKey: getGetAttendanceReportQueryKey(reportParams) },
  });
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

  const counts = useMemo(() => {
    const c = { present: 0, half_day: 0, absent: 0 };
    report?.devices.forEach((d) => {
      c[d.status as keyof typeof c] += 1;
    });
    return c;
  }, [report]);

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
          queryClient.invalidateQueries({ queryKey: getGetAttendanceReportQueryKey(reportParams) });
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
            Daily check-in and worked hours, derived from activity logs.
          </p>
        </div>
        <div className="flex items-end gap-2">
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
