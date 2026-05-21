import * as React from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell,
} from "recharts";
import {
  Monitor, Shield, Camera, Power, Users, Activity, Clock,
  AlertTriangle, MousePointer, Keyboard, RefreshCw, Search,
  Lock, Unlock, Wifi, WifiOff, Eye,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useAppStore } from "../../store";
import type { ActivityLog } from "../../store";
import { activityApi } from "../../lib/api";
import type { Page } from "../Sidebar";


const getAppTitle = (processName: string, windowTitle: string) => {
  const processLower = processName.toLowerCase();
  
  if (processLower !== "powershell" && processLower !== "cmd" && processLower !== "wt") {
    return processName.replace(/\.exe$/i, "");
  }

  const title = windowTitle.trim();
  if (!title) return "Shell";

  if (title.includes("Google Chrome") || title.includes("Chrome")) return "Google Chrome";
  if (title.includes("Antigravity")) return "Antigravity";
  if (title.includes("Visual Studio Code") || title.includes("VS Code") || title.includes("vscode")) return "VS Code";
  if (title.includes("Cursor")) return "Cursor";
  if (title.includes("Slack")) return "Slack";
  if (title.includes("Discord")) return "Discord";
  if (title.includes("Spotify")) return "Spotify";
  if (title.includes("Notepad")) return "Notepad";
  if (title.includes("Teams")) return "Microsoft Teams";
  if (title.includes("Excel")) return "Microsoft Excel";
  if (title.includes("Word")) return "Microsoft Word";

  const delimiters = [" - ", " — ", " | "];
  for (const delim of delimiters) {
    if (title.includes(delim)) {
      const parts = title.split(delim).map(p => p.trim());
      const lastPart = parts[parts.length - 1];
      const isFile = lastPart.includes(".") || lastPart.toLowerCase().endsWith("toml") || lastPart.toLowerCase().endsWith("tsx") || lastPart.toLowerCase().endsWith("ts");
      if (!isFile && lastPart.length > 2) {
        return lastPart;
      }
      for (let i = parts.length - 2; i >= 0; i--) {
        const part = parts[i];
        const isFilePart = part.includes(".") || part.toLowerCase().endsWith("toml") || part.toLowerCase().endsWith("tsx") || part.toLowerCase().endsWith("ts");
        if (!isFilePart && part.length > 2) {
          return part;
        }
      }
    }
  }

  return "Shell";
};

interface DashboardProps {
  onNavigate: (page: Page) => void;
}

export default function Dashboard({ onNavigate }: DashboardProps) {
  const { devices, lockDevice, unlockDevice, selectDevice, refresh } = useAppStore();
  const [logs, setLogs] = React.useState<ActivityLog[]>([]);
  const [searchTerm, setSearchTerm] = React.useState("");
  const [lastRefresh, setLastRefresh] = React.useState(new Date());

  const handleRefresh = React.useCallback(() => {
    refresh(true); // Silent refresh of store devices
    setLastRefresh(new Date());
  }, [refresh]);

  React.useEffect(() => {
    activityApi.timeline().then(setLogs).catch(console.error);
    const timer = setInterval(handleRefresh, 30000);
    return () => clearInterval(timer);
  }, [lastRefresh, handleRefresh]);

  const filteredDevices = devices.filter(
    (d) =>
      d.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      d.user.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const onlineCount = devices.filter((d) => d.status === "online").length;
  const activeDevices = devices.filter((d) => d.status !== "offline");
  const avgProductivity = activeDevices.length > 0
    ? Math.round(activeDevices.reduce((sum, d) => sum + d.productivity, 0) / activeDevices.length)
    : 0;
  const alertCount = devices.filter((d) => d.automationDetected).length;
  const lockedCount = devices.filter((d) => d.isLocked).length;

  // Compute app usage from logs
  const appUsageData = React.useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const usage: Record<string, number> = {};
    logs.forEach((l) => {
      const logDate = new Date(l.startedAt);
      logDate.setHours(0, 0, 0, 0);
      if (logDate.getTime() !== today.getTime()) return;

      if (l.type !== "idle") {
        const appName = getAppTitle(l.processName, l.windowTitle);
        usage[appName] = (usage[appName] || 0) + l.durationSeconds;
      }
    });
    const total = Object.values(usage).reduce((a, b) => a + b, 0);
    if (total === 0) return [];
    const colors = ["#6366f1", "#3b82f6", "#8b5cf6", "#10b981", "#f59e0b"];
    return Object.entries(usage)
      .map(([name, value], i) => ({ name, value: Math.round((value / total) * 100), color: colors[i % colors.length] }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);
  }, [logs]);

  const handleDeviceClick = (deviceId: string) => {
    selectDevice(deviceId);
    onNavigate("timeline");
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            Command Center
          </h1>
          <p className="text-slate-500 dark:text-slate-400 text-sm">
            Last updated: {lastRefresh.toLocaleTimeString()} · {onlineCount}/{devices.length} nodes online
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <Input
              type="search"
              placeholder="Search nodes..."
              className="pl-8 w-[220px]"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <Button variant="outline" size="icon" onClick={handleRefresh} title="Refresh">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-none shadow-sm bg-white dark:bg-slate-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-slate-500">Active Nodes</CardTitle>
            <Monitor className="h-4 w-4 text-indigo-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900 dark:text-white">{onlineCount} / {devices.length}</div>
            <p className="text-xs text-indigo-500 mt-1">
              {devices.filter((d) => d.status === "idle").length} idle
            </p>
          </CardContent>
        </Card>

        <Card className="border-none shadow-sm bg-white dark:bg-slate-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-slate-500">Avg Productivity</CardTitle>
            <Activity className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900 dark:text-white">{avgProductivity}%</div>
            <div className="w-full bg-slate-100 dark:bg-slate-700 h-1.5 rounded-full mt-2 overflow-hidden">
              <div className="bg-emerald-500 h-full rounded-full" style={{ width: `${avgProductivity}%` }} />
            </div>
          </CardContent>
        </Card>

        <Card className="border-none shadow-sm bg-white dark:bg-slate-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-slate-500">Automation Alerts</CardTitle>
            <AlertTriangle className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900 dark:text-white">{alertCount}</div>
            <p className="text-xs text-amber-500 mt-1">
              {alertCount > 0 ? "Mouse jiggler suspected" : "All clear"}
            </p>
          </CardContent>
        </Card>

        <Card className="border-none shadow-sm bg-white dark:bg-slate-800">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-slate-500">Locked Systems</CardTitle>
            <Shield className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900 dark:text-white">{lockedCount}</div>
            <p className="text-xs text-slate-500 mt-1">
              {lockedCount > 0 ? "Remote lockdowns active" : "No lockdowns"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Charts */}
        <div className="lg:col-span-2 space-y-6">
          <Card className="border-none shadow-sm bg-white dark:bg-slate-800">
            <CardHeader>
              <CardTitle className="text-base font-semibold">Productivity Trend</CardTitle>
              <CardDescription className="text-xs">Hourly productive vs unproductive time across all nodes</CardDescription>
            </CardHeader>
            <CardContent className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={React.useMemo(() => {
                  const today = new Date();
                  today.setHours(0, 0, 0, 0);

                  const hours: Record<string, { productive: number; unproductive: number }> = {};
                  for (let h = 9; h <= 17; h++) {
                    const hourStr = `${h.toString().padStart(2, "0")}:00`;
                    hours[hourStr] = { productive: 0, unproductive: 0 };
                  }
                  logs.forEach((log) => {
                    try {
                      const date = new Date(log.startedAt);
                      const checkDate = new Date(date);
                      checkDate.setHours(0, 0, 0, 0);
                      if (checkDate.getTime() !== today.getTime()) return;

                      const h = date.getHours();
                      const hourStr = `${h.toString().padStart(2, "0")}:00`;
                      if (!hours[hourStr]) hours[hourStr] = { productive: 0, unproductive: 0 };
                      const durationMinutes = Math.round(log.durationSeconds / 60);
                      if (log.type === "productive") {
                        hours[hourStr].productive += durationMinutes;
                      } else {
                        hours[hourStr].unproductive += durationMinutes;
                      }
                    } catch (e) {}
                  });
                  return Object.entries(hours)
                    .map(([time, data]) => ({ time, productive: data.productive, unproductive: data.unproductive }))
                    .sort((a, b) => a.time.localeCompare(b.time));
                }, [logs])} margin={{ top: 5, right: 20, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gProd" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gUnprod" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#f43f5e" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-slate-100 dark:stroke-slate-700" />
                  <XAxis dataKey="time" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip contentStyle={{ background: "#1e293b", border: "none", borderRadius: 8, fontSize: 12 }} />
                  <Area type="monotone" dataKey="productive" stroke="#6366f1" fill="url(#gProd)" strokeWidth={2} name="Productive (mins)" />
                  <Area type="monotone" dataKey="unproductive" stroke="#f43f5e" fill="url(#gUnprod)" strokeWidth={2} name="Unproductive (mins)" />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 gap-6">
            {/* App usage pie */}
            <Card className="border-none shadow-sm bg-white dark:bg-slate-800">
              <CardHeader>
                <CardTitle className="text-base font-semibold">Top Applications</CardTitle>
                <CardDescription className="text-xs">By total time today</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4">
                  <div style={{ width: 120, height: 120 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={appUsageData} cx="50%" cy="50%" innerRadius={35} outerRadius={55} paddingAngle={3} dataKey="value">
                          {appUsageData.map((e, i) => <Cell key={i} fill={e.color} />)}
                        </Pie>
                        <Tooltip contentStyle={{ background: "#1e293b", border: "none", borderRadius: 8, fontSize: 11 }} formatter={(v) => `${v}%`} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex-1 space-y-1.5">
                    {appUsageData.length > 0 ? appUsageData.map((item) => (
                      <div key={item.name} className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: item.color }} />
                        <span className="text-xs text-slate-600 dark:text-slate-300 truncate flex-1">{item.name}</span>
                        <span className="text-xs font-medium text-slate-500">{item.value}%</span>
                      </div>
                    )) : (
                      <span className="text-xs text-slate-400">No application usage data today</span>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Input entropy */}
            <Card className="border-none shadow-sm bg-white dark:bg-slate-800">
              <CardHeader>
                <CardTitle className="text-base font-semibold">Input Entropy</CardTitle>
                <CardDescription className="text-xs">Human vs automation pattern analysis</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 pt-2">
                {(() => {
                  const hasAutomationNode = devices.some(d => d.automationDetected && d.status !== "offline");
                  return (
                    <>
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                            <MousePointer className="h-3 w-3 text-indigo-500" /> Mouse Velocity
                          </span>
                          <Badge className={`text-[10px] px-1.5 ${hasAutomationNode ? "bg-amber-100 text-amber-700 border-amber-200" : "bg-emerald-100 text-emerald-700 border-emerald-200"}`}>
                            {hasAutomationNode ? "Suspicious" : "Human"}
                          </Badge>
                        </div>
                        <div className="w-full bg-slate-100 dark:bg-slate-700 h-2 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all ${hasAutomationNode ? "bg-amber-500" : "bg-indigo-500"}`} style={{ width: hasAutomationNode ? "30%" : "78%" }} />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                            <Keyboard className="h-3 w-3 text-indigo-500" /> Keystroke Rhythm
                          </span>
                          <Badge className={`text-[10px] px-1.5 ${hasAutomationNode ? "bg-red-100 text-red-700 border-red-200" : "bg-emerald-100 text-emerald-700 border-emerald-200"}`}>
                            {hasAutomationNode ? "Automated" : "Human"}
                          </Badge>
                        </div>
                        <div className="w-full bg-slate-100 dark:bg-slate-700 h-2 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all ${hasAutomationNode ? "bg-red-500" : "bg-indigo-500"}`} style={{ width: hasAutomationNode ? "15%" : "65%" }} />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                            <Clock className="h-3 w-3 text-indigo-500" /> Click Interval
                          </span>
                          <Badge className={`text-[10px] px-1.5 ${hasAutomationNode ? "bg-amber-100 text-amber-700 border-amber-200" : "bg-emerald-100 text-emerald-700 border-emerald-200"}`}>
                            {hasAutomationNode ? "Uniform" : "Human"}
                          </Badge>
                        </div>
                        <div className="w-full bg-slate-100 dark:bg-slate-700 h-2 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all ${hasAutomationNode ? "bg-amber-500" : "bg-indigo-500"}`} style={{ width: hasAutomationNode ? "90%" : "42%" }} />
                        </div>
                      </div>
                    </>
                  );
                })()}
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Live Nodes Panel */}
        <div className="lg:col-span-1">
          <Card className="border-none shadow-sm bg-white dark:bg-slate-800 h-full">
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <div>
                <CardTitle className="text-base font-semibold">Live Nodes</CardTitle>
                <CardDescription className="text-xs">Click to view timeline</CardDescription>
              </div>
              <Badge variant="outline" className="text-indigo-600 border-indigo-200 bg-indigo-50 text-xs">
                {devices.length} Total
              </Badge>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="relative group">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 group-focus-within:text-indigo-500 transition-colors" />
                <input 
                  type="text"
                  placeholder="Search nodes or users..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-9 pr-4 h-9 bg-slate-50/50 dark:bg-slate-900/50 border border-slate-100 dark:border-slate-800 rounded-lg text-xs outline-none focus:ring-1 focus:ring-indigo-500 transition-all"
                />
              </div>
              <div className="space-y-3">
                {filteredDevices.map((device) => (
                <div
                  key={device.id}
                  className="p-3 border border-slate-100 dark:border-slate-700 rounded-xl hover:border-indigo-200 dark:hover:border-indigo-700 transition-all cursor-pointer group"
                  onClick={() => handleDeviceClick(device.id)}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                        device.status === "online" ? "bg-emerald-500 shadow-sm shadow-emerald-500/50" :
                        device.status === "idle" ? "bg-amber-500" : "bg-slate-400"
                      }`} />
                      <span className="font-semibold text-slate-900 dark:text-white text-sm group-hover:text-indigo-600 transition-colors">
                        {device.name}
                      </span>
                    </div>
                    <div className="flex gap-1">
                      {device.automationDetected && (
                        <Badge variant="destructive" className="text-[9px] px-1 py-0 h-4">Fake</Badge>
                      )}
                      {device.isLocked && (
                        <Badge className="text-[9px] px-1 py-0 h-4 bg-red-500">Locked</Badge>
                      )}
                    </div>
                  </div>

                  <div className="flex justify-between text-xs text-slate-500 mb-2">
                    <span>{device.user}</span>
                    <span>{new Date(device.lastSeen).toLocaleString()}</span>
                  </div>

                  <div className="flex items-center justify-between text-xs mb-2.5">
                    <span className="text-slate-500">
                      {device.status !== "offline" ? `Using: ${device.activeApp === "powershell" ? "Shell" : device.activeApp.replace(/\.exe$/i, "")}` : "Offline"}
                    </span>
                    <span className={`font-bold ${
                      device.productivity >= 80 ? "text-emerald-500" :
                      device.productivity >= 50 ? "text-amber-500" : "text-red-500"
                    }`}>
                      {device.productivity}%
                    </span>
                  </div>

                  {/* Quick Actions */}
                  <div className="flex gap-1.5 justify-end" onClick={(e) => e.stopPropagation()}>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 w-7 p-0"
                      title="View Screenshots"
                      onClick={(e) => { e.stopPropagation(); selectDevice(device.id); onNavigate("screenshots"); }}
                    >
                      <Camera className="h-3 w-3" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 w-7 p-0"
                      title="View Timeline"
                      onClick={(e) => { e.stopPropagation(); handleDeviceClick(device.id); }}
                    >
                      <Eye className="h-3 w-3" />
                    </Button>
                    <Button
                      size="sm"
                      variant={device.isLocked ? "destructive" : "outline"}
                      className="h-7 w-7 p-0"
                      title={device.isLocked ? "Unlock System" : "Lock System"}
                      onClick={(e) => {
                        e.stopPropagation();
                        device.isLocked ? unlockDevice(device.id) : lockDevice(device.id);
                      }}
                    >
                      {device.isLocked ? <Unlock className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                    </Button>
                  </div>
                </div>
              ))}
              </div>
              {filteredDevices.length === 0 && (
                <p className="text-center text-slate-400 text-sm py-8">No nodes match your search.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
