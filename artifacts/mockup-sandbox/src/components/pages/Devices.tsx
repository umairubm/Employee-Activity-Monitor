import * as React from "react";
import {
  Monitor, Lock, Unlock, Wifi, WifiOff, AlertTriangle,
  Clock, Activity, Camera, Eye, ChevronRight, Search,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useAppStore } from "../../store";
import type { Page } from "../Sidebar";

interface DevicesProps {
  onNavigate: (page: Page) => void;
}

export default function Devices({ onNavigate }: DevicesProps) {
  const { devices, lockDevice, unlockDevice, selectDevice } = useAppStore();
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<"all" | "online" | "idle" | "offline">("all");

  const filtered = devices.filter((d) => {
    const matchSearch =
      d.name.toLowerCase().includes(search.toLowerCase()) ||
      d.user.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === "all" || d.status === statusFilter;
    return matchSearch && matchStatus;
  });

  const statusBadge = (status: string) => {
    if (status === "online") return <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 text-[10px]">● Online</Badge>;
    if (status === "idle") return <Badge className="bg-amber-100 text-amber-700 border-amber-200 text-[10px]">● Idle</Badge>;
    return <Badge className="bg-slate-100 text-slate-500 border-slate-200 text-[10px]">● Offline</Badge>;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">Devices</h1>
          <p className="text-slate-500 text-sm">{devices.length} enrolled nodes</p>
        </div>
      </div>

      {/* Filter */}
      <Card className="border-none shadow-sm bg-white dark:bg-slate-800">
        <CardContent className="p-4 flex flex-col md:flex-row gap-3 items-center">
          <div className="relative w-full md:w-[260px]">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <Input placeholder="Search device or user..." className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="flex gap-2">
            {(["all", "online", "idle", "offline"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`text-xs px-3 py-1.5 rounded-full font-medium capitalize transition-all ${
                  statusFilter === s ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card className="border-none shadow-sm bg-white dark:bg-slate-800">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 dark:border-slate-700">
                  <th className="text-left text-xs font-medium text-slate-500 px-6 py-3">Device</th>
                  <th className="text-left text-xs font-medium text-slate-500 px-4 py-3">User</th>
                  <th className="text-left text-xs font-medium text-slate-500 px-4 py-3">Status</th>
                  <th className="text-left text-xs font-medium text-slate-500 px-4 py-3">Productivity</th>
                  <th className="text-left text-xs font-medium text-slate-500 px-4 py-3">Active App</th>
                  <th className="text-left text-xs font-medium text-slate-500 px-4 py-3">Last Seen</th>
                  <th className="text-right text-xs font-medium text-slate-500 px-6 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 dark:divide-slate-700/50">
                {filtered.map((device) => (
                  <tr key={device.id} className="hover:bg-slate-50 dark:hover:bg-slate-750 transition-colors group">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center flex-shrink-0">
                          <Monitor className="h-4 w-4 text-slate-500" />
                        </div>
                        <div>
                          <p className="font-medium text-slate-900 dark:text-white">{device.name}</p>
                          <p className="text-xs text-slate-400 capitalize">{device.os}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <p className="text-slate-700 dark:text-slate-300">{device.user}</p>
                      <p className="text-xs text-slate-400">{device.email}</p>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex flex-col gap-1">
                        {statusBadge(device.status)}
                        {device.isLocked && <Badge className="bg-red-100 text-red-600 border-red-200 text-[10px] w-fit">Locked</Badge>}
                        {device.automationDetected && <Badge className="bg-amber-100 text-amber-600 border-amber-200 text-[10px] w-fit">⚠ Fake Activity</Badge>}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-2">
                        <div className="w-16 bg-slate-100 dark:bg-slate-700 h-1.5 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${device.productivity >= 80 ? "bg-emerald-500" : device.productivity >= 50 ? "bg-amber-500" : "bg-red-500"}`}
                            style={{ width: `${device.productivity}%` }}
                          />
                        </div>
                        <span className={`text-xs font-semibold ${device.productivity >= 80 ? "text-emerald-600" : device.productivity >= 50 ? "text-amber-600" : "text-red-600"}`}>
                          {device.productivity}%
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <span className="text-xs text-slate-600 dark:text-slate-300">{device.activeApp}</span>
                    </td>
                    <td className="px-4 py-4">
                      <span className="text-xs text-slate-500">{device.lastSeen}</span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-1.5 justify-end">
                        <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-slate-400 hover:text-indigo-600"
                          title="View Timeline"
                          onClick={() => { selectDevice(device.id); onNavigate("timeline"); }}>
                          <Clock className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-slate-400 hover:text-indigo-600"
                          title="View Screenshots"
                          onClick={() => { selectDevice(device.id); onNavigate("screenshots"); }}>
                          <Camera className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant={device.isLocked ? "destructive" : "outline"}
                          className="h-8 px-2.5 text-xs"
                          onClick={() => device.isLocked ? unlockDevice(device.id) : lockDevice(device.id)}
                        >
                          {device.isLocked ? <><Unlock className="h-3 w-3 mr-1" />Unlock</> : <><Lock className="h-3 w-3 mr-1" />Lock</>}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <div className="text-center py-12 text-slate-400">
                <Monitor className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No devices match your filter.</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
