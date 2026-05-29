import * as React from "react";
import {
  Monitor, Lock, Unlock, Wifi, WifiOff, AlertTriangle,
  Clock, Camera, Eye, ChevronRight, Search, ListFilter,
  X, ExternalLink, Timer, AppWindow, AppWindow as AppIcon,
  MousePointer2, Zap, Activity
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useAppStore } from "../../store";
import type { ActivityLog } from "../../store";
import { activityApi } from "../../lib/api";
import type { Page } from "../Sidebar";
interface DevicesProps {
  onNavigate: (page: Page) => void;
}

export default function Devices({ onNavigate }: DevicesProps) {
  const { devices, lockDevice, unlockDevice, selectDevice, setDeviceGroup, renameGroup, selectedDate, setSelectedDate } = useAppStore();
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<"all" | "online" | "idle" | "offline">("all");
  const [groupFilter, setGroupFilter] = React.useState<string>("all");
  const [selectedDeviceForLogs, setSelectedDeviceForLogs] = React.useState<string | null>(null);
  const [deviceLogs, setDeviceLogs] = React.useState<ActivityLog[]>([]);

  React.useEffect(() => {
    if (selectedDeviceForLogs) {
      activityApi.timeline(selectedDeviceForLogs, selectedDate).then(setDeviceLogs).catch(console.error);
    } else {
      setDeviceLogs([]);
    }
  }, [selectedDeviceForLogs, selectedDate]);

  const allGroups = React.useMemo(() => Array.from(new Set(devices.map(d => d.deviceGroup || "Unassigned"))).sort(), [devices]);

  const filtered = devices.filter((d) => {
    const matchSearch =
      d.name.toLowerCase().includes(search.toLowerCase()) ||
      d.user.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === "all" || d.status === statusFilter;
    const matchGroup = groupFilter === "all" || (d.deviceGroup || "Unassigned") === groupFilter;
    return matchSearch && matchStatus && matchGroup;
  });


  const statusBadge = (status: string) => {
    if (status === "online") return <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 text-[10px]">● Online</Badge>;
    if (status === "idle") return <Badge className="bg-amber-100 text-amber-700 border-amber-200 text-[10px]">● Idle</Badge>;
    return <Badge className="bg-slate-100 text-slate-500 border-slate-200 text-[10px]">● Offline</Badge>;
  };

  const selectedDevice = devices.find(d => d.id === selectedDeviceForLogs);

  return (
    <div className="relative min-h-[calc(100vh-80px)]">
      <div className={`space-y-6 transition-all duration-300 ${selectedDeviceForLogs ? "pr-[400px]" : ""}`}>
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
                  className={`text-xs px-3 py-1.5 rounded-full font-medium capitalize transition-all ${statusFilter === s ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300"
                    }`}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="ml-auto w-full md:w-auto flex gap-2">
              <Input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="w-[140px] h-9 text-xs"
              />
              <select
                className="w-full md:w-[200px] h-9 rounded-md border border-slate-200 bg-white px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500 dark:border-slate-800 dark:bg-slate-950 dark:focus-visible:ring-indigo-400"
                value={groupFilter}
                onChange={(e) => setGroupFilter(e.target.value)}
              >
                <option value="all">All Groups</option>
                {allGroups.map((g) => (
                  <option key={g} value={g}>{g}</option>
                ))}
              </select>
              {groupFilter !== "all" && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 px-3"
                  onClick={() => {
                    const newName = window.prompt(`Rename group "${groupFilter}" to:`, groupFilter);
                    if (newName && newName.trim() !== "" && newName !== groupFilter) {
                      renameGroup(groupFilter, newName.trim());
                      setGroupFilter(newName.trim());
                    }
                  }}
                >
                  Edit
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Table */}
        <Card className="border-none shadow-sm bg-white dark:bg-slate-800">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead>
                  <tr className="border-b border-slate-100 dark:border-slate-700">
                    <th className="font-medium text-slate-500 px-6 py-3 text-xs uppercase tracking-wider">Device</th>
                    <th className="font-medium text-slate-500 px-4 py-3 text-xs uppercase tracking-wider">User</th>
                    <th className="font-medium text-slate-500 px-4 py-3 text-xs uppercase tracking-wider">Group</th>
                    <th className="font-medium text-slate-500 px-4 py-3 text-xs uppercase tracking-wider">Status</th>
                    <th className="font-medium text-slate-500 px-4 py-3 text-xs uppercase tracking-wider">Productivity</th>
                    <th className="font-medium text-slate-500 px-4 py-3 text-xs uppercase tracking-wider text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 dark:divide-slate-700/50">
                  {filtered.map((device) => (
                    <tr
                      key={device.id}
                      onClick={() => setSelectedDeviceForLogs(device.id)}
                      className={`hover:bg-slate-50 dark:hover:bg-slate-900/50 cursor-pointer transition-colors group ${selectedDeviceForLogs === device.id ? "bg-indigo-50/50 dark:bg-indigo-950/20" : ""}`}
                    >
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors ${selectedDeviceForLogs === device.id ? "bg-indigo-100 dark:bg-indigo-900/50 text-indigo-600" : "bg-slate-100 dark:bg-slate-800 text-slate-500"}`}>
                            <Monitor className="h-4 w-4" />
                          </div>
                          <div>
                            <p className="font-semibold text-slate-900 dark:text-white leading-none mb-1">{device.name}</p>
                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{device.os}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex flex-col">
                          <span className="font-medium text-slate-700 dark:text-slate-300">{device.user}</span>
                          <span className="text-xs text-slate-400">{device.email}</span>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <select
                          value={device.deviceGroup || "Unassigned"}
                          onChange={(e) => {
                            e.stopPropagation();
                            if (e.target.value === "__NEW__") {
                              const newGroup = window.prompt("Enter new group name:");
                              if (newGroup && newGroup.trim() !== "") {
                                setDeviceGroup(device.id, newGroup.trim());
                              }
                            } else {
                              setDeviceGroup(device.id, e.target.value);
                            }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="h-7 w-28 rounded-md border border-slate-200 bg-transparent px-2 py-1 text-xs text-slate-700 dark:border-slate-700 dark:text-slate-300 focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer"
                        >
                          {allGroups.map((g) => (
                            <option key={g} value={g}>{g}</option>
                          ))}
                          <option disabled>──────</option>
                          <option value="__NEW__">+ New Group</option>
                        </select>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex flex-col gap-1">
                          {statusBadge(device.status)}
                          {device.isLocked && <Badge className="bg-red-50 text-red-600 border-red-100 text-[9px] font-bold w-fit py-0 px-1.5">LOCKED</Badge>}
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex items-center gap-3">
                          <div className="flex-1 w-20 bg-slate-100 dark:bg-slate-700 h-1.5 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all duration-500 ${device.productivity >= 80 ? "bg-emerald-500" : device.productivity >= 50 ? "bg-amber-500" : "bg-red-500"}`}
                              style={{ width: `${device.productivity}%` }}
                            />
                          </div>
                          <span className={`text-xs font-bold ${device.productivity >= 80 ? "text-emerald-600" : device.productivity >= 50 ? "text-amber-600" : "text-red-600"}`}>
                            {device.productivity}%
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-1.5 justify-end" onClick={e => e.stopPropagation()}>
                          <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50"
                            title="View Logs"
                            onClick={() => setSelectedDeviceForLogs(device.id)}>
                            <ListFilter className="h-4 w-4" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50"
                            title="Timeline"
                            onClick={() => { selectDevice(device.id); onNavigate("timeline"); }}>
                            <Clock className="h-4 w-4" />
                          </Button>
                          {/* <Button
                            size="sm"
                            variant={device.isLocked ? "destructive" : "outline"}
                            className={`h-8 px-2.5 text-[10px] font-bold uppercase tracking-wider ${device.isLocked ? "" : "border-slate-200 dark:border-slate-700"}`}
                            onClick={() => device.isLocked ? unlockDevice(device.id) : lockDevice(device.id)}
                          >
                            {device.isLocked ? <Unlock className="h-3 w-3 mr-1" /> : <Lock className="h-3 w-3 mr-1" />}
                            {device.isLocked ? "Unlock" : "Lock"}
                          </Button> */}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filtered.length === 0 && (
                <div className="text-center py-20 text-slate-400">
                  <Monitor className="h-10 w-10 mx-auto mb-3 opacity-20" />
                  <p className="text-sm font-medium">No devices found matching "{search}"</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Log Side Panel */}
      <div className={`fixed top-0 right-0 h-screen w-[420px] bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 shadow-2xl transition-transform duration-300 z-50 transform ${selectedDeviceForLogs ? "translate-x-0" : "translate-x-full"}`}>
        {selectedDevice && (
          <div className="flex flex-col h-full">
            <div className="p-5 border-b border-slate-50 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-black/20">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-indigo-600 rounded-lg shadow-lg shadow-indigo-500/20">
                  <Monitor className="h-4 w-4 text-white" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 dark:text-white leading-none">{selectedDevice.name}</h3>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Activity Logs</p>
                </div>
              </div>
              <Button size="sm" variant="ghost" className="h-8 w-8 p-0 rounded-full" onClick={() => setSelectedDeviceForLogs(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
              <div className="space-y-4">
                {deviceLogs.map((log, i) => (
                  <div key={log.id} className="relative pl-6 pb-6 last:pb-0">
                    {/* Timeline Line */}
                    {i !== deviceLogs.length - 1 && (
                      <div className="absolute left-2.5 top-5 bottom-0 w-px bg-slate-200 dark:bg-slate-800" />
                    )}

                    {/* Dot */}
                    <div className={`absolute left-0 top-1 w-5 h-5 rounded-full border-2 bg-white dark:bg-slate-900 flex items-center justify-center z-10 ${log.type === "productive" ? "border-emerald-500" :
                        log.type === "neutral" ? "border-slate-400" :
                          log.type === "idle" ? "border-amber-500" :
                            "border-indigo-500"
                      }`}>
                      {log.type === "idle" ? <Clock className="h-2.5 w-2.5 text-amber-500" /> : <Zap className="h-2.5 w-2.5 text-slate-400" />}
                    </div>

                    <div className="bg-slate-50 dark:bg-slate-800/50 rounded-xl p-3 border border-slate-100 dark:border-slate-800/50 group hover:shadow-md transition-all">
                      <div className="flex justify-between items-start mb-2">
                        <span className="text-[10px] font-black text-slate-400 tracking-tighter bg-white dark:bg-slate-900 px-1.5 py-0.5 rounded border border-slate-100 dark:border-slate-800">
                          {new Date(log.startedAt).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                      </div>

                      <div className="space-y-1.5">
                        <div className="flex items-center gap-2">
                          <div className="p-1.5 bg-white dark:bg-slate-900 rounded border border-slate-100 dark:border-slate-800">
                            <AppIcon className="h-3 w-3 text-indigo-500" />
                          </div>
                          <span className="text-xs font-bold text-slate-800 dark:text-slate-200 truncate max-w-[240px]">
                            {log.processName}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed pl-8 italic">
                          "{log.windowTitle}"
                        </p>
                      </div>

                      <div className="mt-3 flex items-center gap-2 pl-8">
                        <Badge className={`text-[9px] font-black uppercase py-0 px-1.5 tracking-tighter ${log.type === "productive" ? "bg-emerald-500" :
                            log.type === "neutral" ? "bg-slate-500" :
                              log.type === "idle" ? "bg-amber-500" :
                                "bg-indigo-500"
                          }`}>
                          {log.type}
                        </Badge>
                        <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">{log.category}</span>
                      </div>
                    </div>
                  </div>
                ))}
                {deviceLogs.length === 0 && (
                  <div className="text-center py-20 opacity-30">
                    <Activity className="h-10 w-10 mx-auto mb-3" />
                    <p className="text-sm">No activity logs recorded for today.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="p-4 border-t border-slate-50 dark:border-slate-800 bg-slate-50/30 dark:bg-black/10">
              <Button className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold" onClick={() => { selectDevice(selectedDevice.id); onNavigate("timeline"); }}>
                Open Full Timeline
                <ExternalLink className="h-4 w-4 ml-2" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
