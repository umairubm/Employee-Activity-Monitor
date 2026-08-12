import React, { useEffect, useState } from "react";
import { 
  useGetDevice, 
  getGetDeviceQueryKey, 
  useGetDeviceCommands, 
  getGetDeviceCommandsQueryKey, 
  useIssueDeviceCommand,
  useListShifts,
  useCancelDeviceCommand,
  useSetDeviceGroup,
  useGetDeviceAlerts,
  getGetDeviceAlertsQueryKey,
  useAcknowledgeDeviceAlert,
  useAcknowledgeAllDeviceAlerts,
  type DeviceAlertItem
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
import { MonitorSmartphone, ShieldAlert, LogOut, Clock, ShieldCheck, Cpu, Ban, Users, Pencil, AlertTriangle, HardDrive, Check, MemoryStick, Network, Server, LockOpen, KeyRound, RotateCcw, Power, Usb, Gauge } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDistanceToNow } from "date-fns";
import { format } from "date-fns";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { AgentUpdateDialog } from "@/components/AgentUpdateDialog";

const SYSTEM_INFO_GROUPS: { label: string; icon: typeof Server; fields: string[] }[] = [
  { label: "System", icon: Server, fields: ["Host Name", "Operating System", "OS Version", "Manufacturer", "Model", "Serial_Number"] },
  { label: "Processor", icon: Cpu, fields: ["Processor", "CPU", "CPU_Core"] },
  { label: "Memory", icon: MemoryStick, fields: ["Ram_Size", "Ram_Type"] },
  { label: "Storage", icon: HardDrive, fields: ["Total Disk Space", "HD Size", "HD_Type", "Available Space"] },
  { label: "Network", icon: Network, fields: ["Ip"] },
];

type IssuableCommand =
  | "lock_screen"
  | "logout_user"
  | "unlock_screen"
  | "restart"
  | "shutdown";

const COMMAND_LABELS: Record<string, string> = {
  lock_screen: "Lock Screen",
  logout_user: "Logout User",
  unlock_screen: "Unlock Device",
  reset_password: "Reset Password",
  restart: "Restart",
  shutdown: "Shutdown",
  set_usb_block: "USB Storage",
  update_config: "Update Config",
  update_agent: "Update Agent",
};

/** Duration picker choices for Lock Screen / Force Sign Out. */
const LOCK_DURATIONS: { value: string; label: string }[] = [
  { value: "15", label: "15 Minutes" },
  { value: "30", label: "30 Minutes" },
  { value: "60", label: "1 Hour" },
  { value: "240", label: "4 Hours" },
  { value: "shift", label: "Until End of Shift" },
  { value: "manual", label: "Until Manually Unlocked" },
];

/** Minutes from now until the next occurrence of "HH:MM" local time. */
function minutesUntil(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const target = new Date();
  target.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
  return Math.max(1, Math.round((target.getTime() - Date.now()) / 60000));
}

/** "34m remaining" / "1h 5m remaining" for the locked badge. */
function remainingLabel(lockedUntil: string, now: number): string | null {
  const ms = new Date(lockedUntil).getTime() - now;
  if (ms <= 0) return null;
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins}m remaining`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m remaining`;
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(1)} TB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

function formatSystemValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function fieldIcon(field: string): typeof Server {
  const group = SYSTEM_INFO_GROUPS.find((g) => g.fields.includes(field));
  return group?.icon ?? AlertTriangle;
}

// DEV-ONLY sample data so the Hardware Change Alerts UI can be previewed.
// Referenced exclusively behind `import.meta.env.DEV`, so Vite strips this from
// the production build (the dead branch is eliminated and the function is
// tree-shaken). Never rendered in the deployed app.
function devMockAlerts(deviceId: string): DeviceAlertItem[] {
  return [
    // Unacknowledged batch — drives the top alert bar + "New changes" table
    { id: "dev-u1", deviceId, field: "Serial_Number", oldValue: "Unknown", newValue: "7QFK6P2", detectedAt: "2026-06-30T16:01:00.000Z", acknowledgedAt: null, acknowledgedByUsername: null },
    { id: "dev-u2", deviceId, field: "Ram_Size", oldValue: "8 GB", newValue: "16 GB", detectedAt: "2026-06-30T16:01:00.000Z", acknowledgedAt: null, acknowledgedByUsername: null },
    { id: "dev-u3", deviceId, field: "HD_Type", oldValue: "HDD", newValue: "SSD", detectedAt: "2026-06-30T16:01:00.000Z", acknowledgedAt: null, acknowledgedByUsername: null },
    // Acknowledged batch 1 — grouped under one date dropdown
    { id: "dev-a1", deviceId, field: "Operating System", oldValue: "Windows 10", newValue: "Windows 11", detectedAt: "2026-06-29T09:30:00.000Z", acknowledgedAt: "2026-06-29T10:00:00.000Z", acknowledgedByUsername: "e2e_admin" },
    { id: "dev-a2", deviceId, field: "OS Version", oldValue: "10.0.19045", newValue: "10.0.22631", detectedAt: "2026-06-29T09:30:00.000Z", acknowledgedAt: "2026-06-29T10:00:00.000Z", acknowledgedByUsername: "e2e_admin" },
    { id: "dev-a3", deviceId, field: "Host Name", oldValue: "DESKTOP-OLD", newValue: "Dell-68", detectedAt: "2026-06-29T09:30:00.000Z", acknowledgedAt: "2026-06-29T10:00:00.000Z", acknowledgedByUsername: "e2e_admin" },
    // Acknowledged batch 2 — second date dropdown
    { id: "dev-a4", deviceId, field: "Processor", oldValue: "Intel i5-8265U", newValue: "Intel i7-1165G7", detectedAt: "2026-06-25T14:12:00.000Z", acknowledgedAt: "2026-06-25T15:00:00.000Z", acknowledgedByUsername: "admin" },
    { id: "dev-a5", deviceId, field: "Model", oldValue: "Vostro 5481", newValue: "Latitude 7420", detectedAt: "2026-06-25T14:12:00.000Z", acknowledgedAt: "2026-06-25T15:00:00.000Z", acknowledgedByUsername: "admin" },
    { id: "dev-a6", deviceId, field: "Total Disk Space", oldValue: "237 GB", newValue: "475 GB", detectedAt: "2026-06-25T14:12:00.000Z", acknowledgedAt: "2026-06-25T15:00:00.000Z", acknowledgedByUsername: "admin" },
  ];
}

export default function DeviceDetail({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: device, isLoading: isDeviceLoading } = useGetDevice(id, { query: { enabled: !!id, queryKey: getGetDeviceQueryKey(id) } });
  const { data: commands, isLoading: isCommandsLoading } = useGetDeviceCommands(id, { query: { enabled: !!id, queryKey: getGetDeviceCommandsQueryKey(id) } });
  const issueCommand = useIssueDeviceCommand();
  const cancelCommand = useCancelDeviceCommand();
  const setDeviceGroup = useSetDeviceGroup();
  const { data: alertsData } = useGetDeviceAlerts(id, { query: { enabled: !!id, queryKey: getGetDeviceAlertsQueryKey(id) } });
  const acknowledgeAlert = useAcknowledgeDeviceAlert();
  const acknowledgeAllAlerts = useAcknowledgeAllDeviceAlerts();
  // Preview the alerts UI with sample data in dev; production uses real data only.
  const alerts = import.meta.env.DEV ? devMockAlerts(id) : alertsData;
  const unackAlerts = (alerts ?? []).filter((a) => !a.acknowledgedAt);
  const ackAlerts = (alerts ?? []).filter((a) => a.acknowledgedAt);
  const ackGroups = Object.values(
    ackAlerts.reduce<Record<string, { key: string; detectedAt: string; items: typeof ackAlerts }>>(
      (acc, a) => {
        const key = a.detectedAt;
        (acc[key] ??= { key, detectedAt: a.detectedAt, items: [] }).items.push(a);
        return acc;
      },
      {},
    ),
  ).sort((a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime());

  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [groupValue, setGroupValue] = useState("");

  const [commandDialogOpen, setCommandDialogOpen] = useState(false);
  const [commandType, setCommandType] = useState<IssuableCommand | null>(null);
  const [commandReason, setCommandReason] = useState("");
  const [lockDuration, setLockDuration] = useState("manual");

  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // Ticks every 30s so the "Locked (34m remaining)" badge counts down live.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const { data: shifts } = useListShifts();

  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelCommandId, setCancelCommandId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  if (isDeviceLoading || isCommandsLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-64 bg-muted rounded-md mb-6"></div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="h-64 bg-muted rounded-xl"></div>
          <div className="lg:col-span-2 h-96 bg-muted rounded-xl"></div>
        </div>
      </div>
    );
  }

  if (!device) return <div>Device not found</div>;

  const afterCommand = (title: string) => {
    queryClient.invalidateQueries({ queryKey: getGetDeviceCommandsQueryKey(id) });
    queryClient.invalidateQueries({ queryKey: getGetDeviceQueryKey(id) });
    toast({ title });
  };

  const handleIssueCommand = () => {
    if (!commandType) return;
    let lockDurationMinutes: number | undefined;
    if (commandType === "lock_screen" || commandType === "logout_user") {
      if (lockDuration === "shift") {
        const end = shifts?.[0]?.endTime;
        lockDurationMinutes = (end && minutesUntil(end)) || undefined;
        if (!lockDurationMinutes) {
          toast({ title: "No shift configured", description: "Set up a shift first, or pick a fixed duration.", variant: "destructive" });
          return;
        }
      } else if (lockDuration !== "manual") {
        lockDurationMinutes = Number(lockDuration);
      }
    }
    issueCommand.mutate({
      id,
      data: { commandType, reason: commandReason || undefined, lockDurationMinutes }
    }, {
      onSuccess: () => {
        setCommandDialogOpen(false);
        setCommandReason("");
        setCommandType(null);
        afterCommand("Command issued successfully");
      },
      onError: (error: any) => {
        toast({ title: "Failed to issue command", description: error.message, variant: "destructive" });
      }
    });
  };

  const handleUnlock = () => {
    issueCommand.mutate({ id, data: { commandType: "unlock_screen" } }, {
      onSuccess: () => afterCommand("Device unlocked — relogin allowed"),
      onError: (error: any) => toast({ title: "Failed to unlock", description: error.message, variant: "destructive" }),
    });
  };

  const handleResetPassword = () => {
    if (newPassword.length < 8 || newPassword !== confirmPassword) return;
    issueCommand.mutate({ id, data: { commandType: "reset_password", newPassword } }, {
      onSuccess: () => {
        setPasswordDialogOpen(false);
        setNewPassword("");
        setConfirmPassword("");
        afterCommand("Password reset command sent");
      },
      onError: (error: any) => toast({ title: "Failed to send password reset", description: error.message, variant: "destructive" }),
    });
  };

  const handleUsbToggle = (enabled: boolean) => {
    issueCommand.mutate({ id, data: { commandType: "set_usb_block", enabled } }, {
      onSuccess: () => afterCommand(enabled ? "USB storage blocked" : "USB storage allowed"),
      onError: (error: any) => toast({ title: "Failed to update USB policy", description: error.message, variant: "destructive" }),
    });
  };

  const openGroupDialog = () => {
    setGroupValue(device?.deviceGroup ?? "");
    setGroupDialogOpen(true);
  };

  const handleSaveGroup = () => {
    const value = groupValue.trim();
    if (!value) return;
    setDeviceGroup.mutate({ id, data: { deviceGroup: value } }, {
      onSuccess: () => {
        setGroupDialogOpen(false);
        queryClient.invalidateQueries({ queryKey: getGetDeviceQueryKey(id) });
        toast({ title: "Group updated" });
      },
      onError: (error: any) => {
        toast({ title: "Failed to update group", description: error.message, variant: "destructive" });
      },
    });
  };

  const openDialog = (type: IssuableCommand) => {
    setCommandType(type);
    setCommandReason("");
    setLockDuration("manual");
    setCommandDialogOpen(true);
  };

  const openCancelDialog = (commandId: string) => {
    setCancelCommandId(commandId);
    setCancelReason("");
    setCancelDialogOpen(true);
  };

  const handleCancelCommand = () => {
    if (!cancelCommandId) return;
    cancelCommand.mutate({ id, commandId: cancelCommandId, data: { reason: cancelReason || undefined } }, {
      onSuccess: () => {
        setCancelDialogOpen(false);
        setCancelCommandId(null);
        setCancelReason("");
        queryClient.invalidateQueries({ queryKey: getGetDeviceCommandsQueryKey(id) });
        toast({ title: "Command cancelled" });
      },
      onError: (error: any) => {
        toast({ title: "Failed to cancel command", description: error.message, variant: "destructive" });
      }
    });
  };

  const refetchAlerts = () => {
    queryClient.invalidateQueries({ queryKey: getGetDeviceAlertsQueryKey(id) });
    queryClient.invalidateQueries({ queryKey: getGetDeviceQueryKey(id) });
  };

  const handleAcknowledge = (alertId: string) => {
    acknowledgeAlert.mutate({ id, alertId }, {
      onSuccess: () => { refetchAlerts(); toast({ title: "Alert acknowledged" }); },
      onError: (error: any) => toast({ title: "Failed to acknowledge", description: error.message, variant: "destructive" }),
    });
  };

  const handleAcknowledgeAll = () => {
    acknowledgeAllAlerts.mutate({ id }, {
      onSuccess: (result) => { refetchAlerts(); toast({ title: "All alerts acknowledged", description: `${result.acknowledged} change(s) cleared.` }); },
      onError: (error: any) => toast({ title: "Failed to acknowledge", description: error.message, variant: "destructive" }),
    });
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <MonitorSmartphone className="h-6 w-6 text-primary" />
            <h1 className="text-3xl font-bold tracking-tight">{device.systemName}</h1>
            {device.online ? (
              <Badge className="bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 border-emerald-500/20">Online</Badge>
            ) : (
              <Badge variant="secondary">Offline</Badge>
            )}
            {device.isLocked && (
              <Badge variant="destructive">
                {device.lockedUntil && remainingLabel(device.lockedUntil, now)
                  ? `Locked (${remainingLabel(device.lockedUntil, now)})`
                  : "Locked"}
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground font-mono text-sm">{device.hardwareHash}</p>
        </div>
        
        <div className="flex flex-wrap gap-2">
          <AgentUpdateDialog selectedDevice={device} defaultTargetMode="device" />
          {device.isLocked && (
            <Button
              className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={handleUnlock}
              disabled={issueCommand.isPending}
            >
              <LockOpen className="h-4 w-4" />
              {issueCommand.isPending ? "Unlocking..." : "Unlock Device / Allow Relogin Now"}
            </Button>
          )}
          <Button variant="outline" className="gap-2" onClick={() => openDialog('logout_user')}>
            <LogOut className="h-4 w-4" />
            Force Sign Out
          </Button>
          <Button variant="destructive" className="gap-2" onClick={() => openDialog('lock_screen')}>
            <ShieldAlert className="h-4 w-4" />
            Lock Screen
          </Button>
        </div>
      </div>

      {unackAlerts.length > 0 && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <div className="flex items-center gap-2.5 text-sm">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
            <span className="font-medium text-amber-900 dark:text-amber-200">
              {unackAlerts.length} hardware change{unackAlerts.length > 1 ? "s" : ""} detected on this device.
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={() => document.getElementById("hardware-change-alerts")?.scrollIntoView({ behavior: "smooth", block: "start" })}
            >
              View changes
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={handleAcknowledgeAll} disabled={acknowledgeAllAlerts.isPending}>
              <Check className="h-3.5 w-3.5" />
              Acknowledge all
            </Button>
          </div>
        </div>
      )}

      <Dialog open={groupDialogOpen} onOpenChange={setGroupDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign Group</DialogTitle>
            <DialogDescription>
              Move this device into a team or group. Devices in the same group are
              filtered and compared together across the dashboard.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="device-group" className="mb-2 block">Group name</Label>
            <Input
              id="device-group"
              placeholder="e.g. Engineering"
              value={groupValue}
              onChange={(e) => setGroupValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSaveGroup()}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGroupDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveGroup} disabled={setDeviceGroup.isPending || !groupValue.trim()}>
              {setDeviceGroup.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={commandDialogOpen} onOpenChange={setCommandDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {commandType === 'restart' ? 'Restart Device' :
               commandType === 'shutdown' ? 'Force Shutdown' : 'Issue Command'}
            </DialogTitle>
            <DialogDescription>
              {commandType === 'lock_screen'
                ? "This will immediately lock the device screen and keep it locked for the selected duration."
                : commandType === 'logout_user'
                ? "This will force the user to sign out and block relogin for the selected duration."
                : commandType === 'restart'
                ? "The device will restart within seconds of its next check-in. Unsaved work may be lost."
                : "The device will power off within seconds of its next check-in. Unsaved work may be lost."}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-4">
            {(commandType === 'lock_screen' || commandType === 'logout_user') && (
              <div>
                <Label className="mb-2 block">Duration</Label>
                <Select value={lockDuration} onValueChange={setLockDuration}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOCK_DURATIONS.map((d) => (
                      <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div>
              <Label htmlFor="reason" className="mb-2 block">Reason (Optional)</Label>
              <Input 
                id="reason" 
                placeholder="e.g. Suspicious activity detected"
                value={commandReason}
                onChange={(e) => setCommandReason(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCommandDialogOpen(false)}>Cancel</Button>
            <Button 
              variant={commandType === 'logout_user' ? "default" : "destructive"} 
              onClick={handleIssueCommand}
              disabled={issueCommand.isPending}
            >
              {issueCommand.isPending ? "Issuing..." : "Confirm Action"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={passwordDialogOpen} onOpenChange={(open) => { setPasswordDialogOpen(open); if (!open) { setNewPassword(""); setConfirmPassword(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset System Password</DialogTitle>
            <DialogDescription>
              Sends a remote command to change the OS account password on this device. The user will need the new password to sign in.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-4">
            <div>
              <Label htmlFor="new-password" className="mb-2 block">New System Password</Label>
              <Input
                id="new-password"
                type="password"
                placeholder="At least 8 characters"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="confirm-password" className="mb-2 block">Confirm Password</Label>
              <Input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
              {confirmPassword.length > 0 && newPassword !== confirmPassword && (
                <p className="text-xs text-destructive mt-1.5">Passwords do not match.</p>
              )}
              {newPassword.length > 0 && newPassword.length < 8 && (
                <p className="text-xs text-destructive mt-1.5">Password must be at least 8 characters.</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPasswordDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={handleResetPassword}
              disabled={issueCommand.isPending || newPassword.length < 8 || newPassword !== confirmPassword}
            >
              {issueCommand.isPending ? "Sending..." : "Change Password"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel Command</DialogTitle>
            <DialogDescription>
              This will cancel the still-pending command before the device picks it up. You can record why it was called off for the audit trail.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="cancel-reason" className="mb-2 block">Reason (Optional)</Label>
            <Input
              id="cancel-reason"
              placeholder="e.g. Issued by mistake"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelDialogOpen(false)}>Keep Command</Button>
            <Button
              variant="destructive"
              onClick={handleCancelCommand}
              disabled={cancelCommand.isPending}
            >
              {cancelCommand.isPending ? "Cancelling..." : "Cancel Command"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-muted-foreground" />
              Device Actions
            </CardTitle>
            <CardDescription>Remote management commands executed by the device agent on its next check-in.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <TooltipProvider>
              <div className="grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-3 gap-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline" className="gap-2 w-full min-w-0 whitespace-normal text-center leading-tight" onClick={() => setPasswordDialogOpen(true)}>
                      <KeyRound className="h-4 w-4 shrink-0" />
                      <span className="min-w-0">Reset System Password</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Remotely change the OS account password</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline" className="gap-2 w-full min-w-0 whitespace-normal text-center leading-tight" onClick={() => openDialog('restart')}>
                      <RotateCcw className="h-4 w-4 shrink-0" />
                      <span className="min-w-0">Restart Device</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Reboot the device (confirmation required)</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline" className="gap-2 w-full min-w-0 whitespace-normal text-center leading-tight text-destructive hover:text-destructive" onClick={() => openDialog('shutdown')}>
                      <Power className="h-4 w-4 shrink-0" />
                      <span className="min-w-0">Force Shutdown</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Power off the device (confirmation required)</TooltipContent>
                </Tooltip>
              </div>
              <div className="flex items-center justify-between rounded-md border border-border bg-muted/40 p-3">
                <div className="flex items-center gap-2.5">
                  <Usb className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">Block USB Storage</p>
                    <p className="text-xs text-muted-foreground">Prevent USB mass-storage devices from mounting</p>
                  </div>
                </div>
                <Switch
                  checked={device.usbBlockEnabled ?? false}
                  onCheckedChange={handleUsbToggle}
                  disabled={issueCommand.isPending}
                />
              </div>
            </TooltipProvider>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Gauge className="h-5 w-5 text-muted-foreground" />
              System Metrics
            </CardTitle>
            <CardDescription>
              {device.metricsAt
                ? `Live utilization · updated ${formatDistanceToNow(new Date(device.metricsAt), { addSuffix: true })}`
                : "Live utilization reported by the agent on each check-in."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {device.metrics ? (
              <>
                {[
                  { label: "CPU Usage", value: device.metrics.cpuPercent, icon: Cpu },
                  { label: "RAM Usage", value: device.metrics.ramPercent, icon: MemoryStick },
                ].map(({ label, value, icon: Icon }) => (
                  <div key={label}>
                    <div className="flex items-center justify-between text-sm mb-1.5">
                      <span className="flex items-center gap-1.5 text-muted-foreground"><Icon className="h-3.5 w-3.5" />{label}</span>
                      <span className="font-medium">{value != null ? `${Math.round(value)}%` : "—"}</span>
                    </div>
                    <Progress value={value ?? 0} className={value != null && value > 90 ? "[&>div]:bg-destructive" : ""} />
                  </div>
                ))}
                <div>
                  <div className="flex items-center justify-between text-sm mb-1.5">
                    <span className="flex items-center gap-1.5 text-muted-foreground"><HardDrive className="h-3.5 w-3.5" />Disk Space Free</span>
                    <span className="font-medium">
                      {device.metrics.diskFreeBytes != null ? formatBytes(device.metrics.diskFreeBytes) : "—"}
                      {device.metrics.diskTotalBytes ? ` of ${formatBytes(device.metrics.diskTotalBytes)}` : ""}
                    </span>
                  </div>
                  {device.metrics.diskFreeBytes != null && device.metrics.diskTotalBytes ? (
                    <Progress value={100 - (device.metrics.diskFreeBytes / device.metrics.diskTotalBytes) * 100} />
                  ) : null}
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No metrics reported yet. Metrics appear after the device agent's next check-in (agent update required).
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-lg">Device Info</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-2 rounded-md bg-muted/40 border border-border p-3">
              <div className="min-w-0">
                <p className="text-muted-foreground text-xs mb-1 flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5" /> Group
                </p>
                <Badge variant="secondary" className="font-normal">{device.deviceGroup}</Badge>
              </div>
              <Button variant="outline" size="sm" className="gap-1.5 shrink-0" onClick={openGroupDialog}>
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-y-4 gap-x-4 text-sm">
              <div>
                <p className="text-muted-foreground mb-1">Operating System</p>
                <p className="font-medium capitalize flex items-center gap-1.5"><Cpu className="h-3.5 w-3.5" />{device.osType}</p>
              </div>
              <div>
                <p className="text-muted-foreground mb-1">Agent Version</p>
                <p className="font-medium">{device.agentVersion || "Unknown"}</p>
              </div>
              <div>
                <p className="text-muted-foreground mb-1">Enrolled At</p>
                <p className="font-medium">{device.enrolledAt ? format(new Date(device.enrolledAt), "MMM d, yyyy") : "-"}</p>
              </div>
              <div>
                <p className="text-muted-foreground mb-1">Last Seen</p>
                <p className="font-medium">{device.lastSeenAt ? format(new Date(device.lastSeenAt), "MMM d, HH:mm") : "-"}</p>
              </div>
            </div>

            <div className="pt-4 mt-4 border-t border-border">
              <p className="text-sm font-medium mb-3 flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-primary" />
                Consent Status
              </p>
              {device.consentAcknowledgedAt ? (
                <div className="bg-primary/5 border border-primary/10 rounded-md p-3 text-sm">
                  <p className="font-medium text-primary mb-1">Acknowledged by {device.consentName}</p>
                  <p className="text-muted-foreground text-xs">On {format(new Date(device.consentAcknowledgedAt), "PPp")}</p>
                </div>
              ) : (
                <div className="bg-muted rounded-md p-3 text-sm text-muted-foreground">
                  Consent pending or not recorded.
                </div>
              )}
            </div>

            <div className="pt-4 mt-4 border-t border-border">
              <p className="text-sm font-medium mb-3">Monitoring Config</p>
              <div className="grid grid-cols-2 gap-y-3 text-xs">
                <div>
                  <p className="text-muted-foreground">Screenshots</p>
                  <p className="font-medium">Every {device.screenshotMinMinutes}-{device.screenshotMaxMinutes}m</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Idle Threshold</p>
                  <p className="font-medium">{device.idleThresholdSeconds}s</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Sync Interval</p>
                  <p className="font-medium">{device.syncIntervalSeconds}s</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Status</p>
                  <p className="font-medium">{device.monitoringEnabled ? "Enabled" : "Disabled"}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Clock className="h-5 w-5 text-muted-foreground" />
              Command History
            </CardTitle>
            <CardDescription>Recent IT commands issued to this device.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Issued By</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Issued</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {commands?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                      No commands have been issued.
                    </TableCell>
                  </TableRow>
                ) : (
                  commands?.map(cmd => (
                    <TableRow key={cmd.id}>
                      <TableCell className="font-medium">
                        <div>{COMMAND_LABELS[cmd.commandType] ?? cmd.commandType}</div>
                        {cmd.commandType === "update_agent" && cmd.targetVersion && (
                          <div className="text-xs font-normal text-muted-foreground">
                            Target v{cmd.targetVersion}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={
                          cmd.status === 'completed' ? 'default' :
                          cmd.status === 'failed' ? 'destructive' :
                          cmd.status === 'pending' ? 'secondary' : 'outline'
                        } className={cmd.status === 'completed' ? "bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 border-emerald-500/20" : ""}>
                           {cmd.commandType === "update_agent" && cmd.status === "completed" && cmd.targetVersion
                             ? `Successfully Updated to v${cmd.targetVersion}`
                             : cmd.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        <div>{cmd.issuedByUsername || "Unknown"}</div>
                        {cmd.status === 'cancelled' && (
                          <div className="text-xs text-destructive/80">
                            Cancelled by {cmd.cancelledByUsername || "Unknown"}
                            {cmd.cancelledAt ? ` · ${format(new Date(cmd.cancelledAt), "MMM d, HH:mm")}` : ""}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[200px]">
                        <div className="truncate">{cmd.reason || "-"}</div>
                        {cmd.status === 'cancelled' && cmd.cancelReason && (
                          <div className="text-xs text-destructive/80 truncate" title={cmd.cancelReason}>
                            Cancelled: {cmd.cancelReason}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {format(new Date(cmd.issuedAt), "MMM d, HH:mm")}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {cmd.completedAt ? format(new Date(cmd.completedAt), "MMM d, HH:mm") : "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        {cmd.status === 'pending' ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="gap-1.5 text-muted-foreground hover:text-destructive"
                            onClick={() => openCancelDialog(cmd.id)}
                            disabled={cancelCommand.isPending}
                          >
                            <Ban className="h-3.5 w-3.5" />
                            Cancel
                          </Button>
                        ) : (
                          <span className="text-muted-foreground text-sm">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <HardDrive className="h-5 w-5 text-muted-foreground" />
            System Information
          </CardTitle>
          <CardDescription>Latest hardware inventory reported by the agent.</CardDescription>
        </CardHeader>
        <CardContent>
          {device.systemInfo && Object.keys(device.systemInfo).length > 0 ? (
            (() => {
              const info = device.systemInfo as Record<string, unknown>;
              const known = new Set(SYSTEM_INFO_GROUPS.flatMap((g) => g.fields));
              const otherKeys = Object.keys(info).filter((k) => !known.has(k));
              const sections = [
                ...SYSTEM_INFO_GROUPS.map((g) => ({
                  label: g.label,
                  icon: g.icon,
                  keys: g.fields.filter((f) => f in info),
                })),
                ...(otherKeys.length > 0
                  ? [{ label: "Other", icon: MonitorSmartphone, keys: otherKeys }]
                  : []),
              ].filter((s) => s.keys.length > 0);

              return (
                <div className="space-y-6">
                  {sections.map((section) => (
                    <div key={section.label}>
                      <div className="flex items-center gap-2 mb-3 text-sm font-medium text-muted-foreground">
                        <section.icon className="h-4 w-4" />
                        {section.label}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-4 text-sm">
                        {section.keys.map((key) => (
                          <div key={key}>
                            <p className="text-muted-foreground mb-0.5">{key}</p>
                            <p className="font-medium break-words">{formatSystemValue(info[key])}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()
          ) : (
            <p className="text-sm text-muted-foreground">No system information reported yet.</p>
          )}
        </CardContent>
      </Card>

      {alerts && alerts.length > 0 && (
        <Card id="hardware-change-alerts" className="scroll-mt-6">
          <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-500" />
                Hardware Change Alerts
                {unackAlerts.length > 0 && (
                  <Badge variant="destructive">{unackAlerts.length} new</Badge>
                )}
              </CardTitle>
              <CardDescription>
                Changes detected in this device's hardware identity (CPU, RAM, disk size, model, serial, host name, OS).
              </CardDescription>
            </div>
            {unackAlerts.length > 0 && (
              <Button variant="outline" size="sm" className="gap-1.5 shrink-0" onClick={handleAcknowledgeAll} disabled={acknowledgeAllAlerts.isPending}>
                <Check className="h-3.5 w-3.5" />
                Acknowledge all
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-6">
            {unackAlerts.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-3">New changes</p>
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Property</TableHead>
                        <TableHead>Changed</TableHead>
                        <TableHead>Detected</TableHead>
                        <TableHead className="text-right">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {unackAlerts.map((a) => {
                        const Icon = fieldIcon(a.field);
                        return (
                          <TableRow key={a.id}>
                            <TableCell className="font-medium">
                              <span className="flex items-center gap-2">
                                <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                                {a.field}
                              </span>
                            </TableCell>
                            <TableCell className="text-sm">
                              <span className="text-muted-foreground line-through">{a.oldValue ?? "—"}</span>
                              <span className="mx-1.5">→</span>
                              <span className="font-medium">{a.newValue ?? "—"}</span>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                              {format(new Date(a.detectedAt), "MMM d, HH:mm")}
                            </TableCell>
                            <TableCell className="text-right">
                              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => handleAcknowledge(a.id)} disabled={acknowledgeAlert.isPending}>
                                <Check className="h-3.5 w-3.5" />
                                Acknowledge
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}

            {ackGroups.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-3 text-muted-foreground">Acknowledged history</p>
                <Accordion type="multiple" className="space-y-2">
                  {ackGroups.map((group) => (
                    <AccordionItem key={group.key} value={group.key} className="border rounded-md px-3">
                      <AccordionTrigger className="hover:no-underline py-3">
                        <div className="flex items-center justify-between gap-3 w-full pr-2">
                          <span className="text-sm font-medium">
                            {format(new Date(group.detectedAt), "MMM d, yyyy · HH:mm")}
                          </span>
                          <div className="flex items-center gap-1.5">
                            {Array.from(
                              new Map(
                                group.items.map((a) => {
                                  const g = SYSTEM_INFO_GROUPS.find((s) => s.fields.includes(a.field));
                                  return [g?.label ?? "Other", g?.icon ?? AlertTriangle] as const;
                                }),
                              ).entries(),
                            ).map(([label, Icon]) => (
                              <Icon key={label} className="h-3.5 w-3.5 text-muted-foreground" />
                            ))}
                            <Badge variant="secondary" className="ml-1 font-normal">{group.items.length}</Badge>
                          </div>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent>
                        <Table>
                          <TableBody>
                            {group.items.map((a) => {
                              const Icon = fieldIcon(a.field);
                              return (
                                <TableRow key={a.id}>
                                  <TableCell className="font-medium">
                                    <span className="flex items-center gap-2">
                                      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                                      {a.field}
                                    </span>
                                  </TableCell>
                                  <TableCell className="text-sm">
                                    <span className="text-muted-foreground line-through">{a.oldValue ?? "—"}</span>
                                    <span className="mx-1.5">→</span>
                                    <span className="font-medium">{a.newValue ?? "—"}</span>
                                  </TableCell>
                                  <TableCell className="text-right text-xs text-muted-foreground whitespace-nowrap">
                                    Acknowledged{a.acknowledgedByUsername ? ` by ${a.acknowledgedByUsername}` : ""}
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </AccordionContent>
                    </AccordionItem>
                  ))}
                </Accordion>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
