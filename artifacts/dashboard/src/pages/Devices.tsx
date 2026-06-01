import React, { useState } from "react";
import { useListDevices } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { MonitorSmartphone, Search, CheckCircle2, XCircle, Clock, ShieldCheck } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

export default function Devices() {
  const { data: devices, isLoading } = useListDevices();
  const [search, setSearch] = useState("");

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 bg-muted rounded-md mb-6"></div>
        <div className="h-[400px] bg-muted rounded-xl"></div>
      </div>
    );
  }

  const filteredDevices = devices?.filter(d => 
    d.systemName.toLowerCase().includes(search.toLowerCase()) || 
    d.hardwareHash.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Devices</h1>
          <p className="text-muted-foreground mt-1">Monitor enrolled company devices.</p>
        </div>
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

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>System Name</TableHead>
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
                  <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                    No devices found.
                  </TableCell>
                </TableRow>
              ) : (
                filteredDevices?.map(device => (
                  <TableRow key={device.id} className="group">
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <MonitorSmartphone className="h-4 w-4 text-muted-foreground" />
                        {device.systemName}
                        {device.isLocked && <Badge variant="destructive" className="ml-2 text-[10px]">Locked</Badge>}
                      </div>
                      <div className="text-xs text-muted-foreground font-mono mt-1">{device.hardwareHash.substring(0, 8)}...</div>
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
                        {device.lastSeenAt ? formatDistanceToNow(new Date(device.lastSeenAt), { addSuffix: true }) : 'Never'}
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
    </div>
  );
}
