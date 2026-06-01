import React, { useState } from "react";
import { 
  useGetDevice, 
  getGetDeviceQueryKey, 
  useGetDeviceCommands, 
  getGetDeviceCommandsQueryKey, 
  useIssueDeviceCommand 
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MonitorSmartphone, ShieldAlert, LogOut, Clock, ShieldCheck, Cpu } from "lucide-react";
import { format } from "date-fns";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

export default function DeviceDetail({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: device, isLoading: isDeviceLoading } = useGetDevice(id, { query: { enabled: !!id, queryKey: getGetDeviceQueryKey(id) } });
  const { data: commands, isLoading: isCommandsLoading } = useGetDeviceCommands(id, { query: { enabled: !!id, queryKey: getGetDeviceCommandsQueryKey(id) } });
  const issueCommand = useIssueDeviceCommand();
  
  const [commandDialogOpen, setCommandDialogOpen] = useState(false);
  const [commandType, setCommandType] = useState<'lock_screen' | 'logout_user' | null>(null);
  const [commandReason, setCommandReason] = useState("");

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

  const handleIssueCommand = () => {
    if (!commandType) return;
    issueCommand.mutate({
      id,
      data: { commandType, reason: commandReason || undefined }
    }, {
      onSuccess: () => {
        setCommandDialogOpen(false);
        setCommandReason("");
        setCommandType(null);
        queryClient.invalidateQueries({ queryKey: getGetDeviceCommandsQueryKey(id) });
        toast({ title: "Command issued successfully" });
      },
      onError: (error: any) => {
        toast({ title: "Failed to issue command", description: error.message, variant: "destructive" });
      }
    });
  };

  const openDialog = (type: 'lock_screen' | 'logout_user') => {
    setCommandType(type);
    setCommandReason("");
    setCommandDialogOpen(true);
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
            {device.isLocked && <Badge variant="destructive">Locked</Badge>}
          </div>
          <p className="text-muted-foreground font-mono text-sm">{device.hardwareHash}</p>
        </div>
        
        <div className="flex gap-2">
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

      <Dialog open={commandDialogOpen} onOpenChange={setCommandDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Issue Command</DialogTitle>
            <DialogDescription>
              {commandType === 'lock_screen' 
                ? "This will immediately lock the device screen. The user will need their OS credentials to unlock." 
                : "This will force the user to sign out of their current OS session."}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="reason" className="mb-2 block">Reason (Optional)</Label>
            <Input 
              id="reason" 
              placeholder="e.g. Suspicious activity detected"
              value={commandReason}
              onChange={(e) => setCommandReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCommandDialogOpen(false)}>Cancel</Button>
            <Button 
              variant={commandType === 'lock_screen' ? "destructive" : "default"} 
              onClick={handleIssueCommand}
              disabled={issueCommand.isPending}
            >
              {issueCommand.isPending ? "Issuing..." : "Confirm Action"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-lg">Device Info</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
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
                  <TableHead>Reason</TableHead>
                  <TableHead>Issued</TableHead>
                  <TableHead>Completed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {commands?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                      No commands have been issued.
                    </TableCell>
                  </TableRow>
                ) : (
                  commands?.map(cmd => (
                    <TableRow key={cmd.id}>
                      <TableCell className="font-medium">
                        {cmd.commandType === 'lock_screen' ? 'Lock Screen' : 'Logout User'}
                      </TableCell>
                      <TableCell>
                        <Badge variant={
                          cmd.status === 'completed' ? 'default' :
                          cmd.status === 'failed' ? 'destructive' :
                          cmd.status === 'pending' ? 'secondary' : 'outline'
                        } className={cmd.status === 'completed' ? "bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 border-emerald-500/20" : ""}>
                          {cmd.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
                        {cmd.reason || "-"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {format(new Date(cmd.issuedAt), "MMM d, HH:mm")}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {cmd.completedAt ? format(new Date(cmd.completedAt), "MMM d, HH:mm") : "-"}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
