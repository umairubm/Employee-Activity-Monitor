import * as React from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import {
  Monitor,
  Shield,
  Camera,
  Power,
  Users,
  Settings,
  Activity,
  Clock,
  AlertTriangle,
  MousePointer,
  Keyboard,
  RefreshCw,
  Search,
  CheckCircle2,
  XCircle,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { activityApi } from "../../lib/api";

// Mock Data
const productivityData = [
  { time: "09:00", productive: 80, unproductive: 20 },
  { time: "10:00", productive: 90, unproductive: 10 },
  { time: "11:00", productive: 70, unproductive: 30 },
  { time: "12:00", productive: 40, unproductive: 60 },
  { time: "13:00", productive: 85, unproductive: 15 },
  { time: "14:00", productive: 95, unproductive: 5 },
  { time: "15:00", productive: 60, unproductive: 40 },
  { time: "16:00", productive: 75, unproductive: 25 },
];

const appUsageData = [
  { name: "VS Code", value: 45, color: "#6366f1" },
  { name: "Chrome", value: 30, color: "#3b82f6" },
  { name: "MS Teams", value: 15, color: "#8b5cf6" },
  { name: "Terminal", value: 10, color: "#10b981" },
];

const devices = [
  {
    id: "1",
    name: "DELL-68",
    user: "Hassan Raza",
    status: "online",
    productivity: 85,
    lastSeen: "Just now",
    automation: false,
    isLocked: false,
  },
  {
    id: "2",
    name: "MAC-PRO-01",
    user: "Sarah Smith",
    status: "online",
    productivity: 92,
    lastSeen: "2m ago",
    automation: false,
    isLocked: false,
  },
  {
    id: "3",
    name: "DESKTOP-FK",
    user: "John Doe",
    status: "idle",
    productivity: 45,
    lastSeen: "15m ago",
    automation: true,
    isLocked: false,
  },
  {
    id: "4",
    name: "WORK-LAPTOP",
    user: "Alice Brown",
    status: "offline",
    productivity: 0,
    lastSeen: "2h ago",
    automation: false,
    isLocked: true,
  },
];

export function Preview() {
  const [searchTerm, setSearchTerm] = React.useState("");
  const [logs, setLogs] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    activityApi.list()
      .then(data => {
        setLogs(data);
        setLoading(false);
      })
      .catch(err => {
        console.error(err);
        setLoading(false);
      });
  }, []);

  const computedAppUsage = React.useMemo(() => {
    if (!logs.length) return appUsageData;
    
    const usage: Record<string, number> = {};
    logs.forEach(log => {
      usage[log.processName] = (usage[log.processName] || 0) + log.durationSeconds;
    });
    
    const total = Object.values(usage).reduce((a, b) => a + b, 0);
    
    const colors = ["#6366f1", "#3b82f6", "#8b5cf6", "#10b981"];
    
    return Object.entries(usage)
      .map(([name, value], index) => ({
        name,
        value: Math.round((value / total) * 100),
        color: colors[index % colors.length]
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 4);
  }, [logs]);

  return (
    <div className="min-h-screen bg-slate-50/50 dark:bg-slate-900 p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-white">Active Tracker Pro</h1>
          <p className="text-slate-500 dark:text-slate-400">Employee Activity Monitoring & Analytics</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <Input
              type="search"
              placeholder="Search nodes..."
              className="pl-8 w-[250px] bg-white dark:bg-slate-800"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <Button variant="outline" size="icon" className="bg-white dark:bg-slate-800">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button className="bg-indigo-600 hover:bg-indigo-700 text-white">
            <Shield className="mr-2 h-4 w-4" /> Admin Console
          </Button>
        </div>
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card className="bg-white dark:bg-slate-800 border-none shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-slate-500 dark:text-slate-400">Total Active Nodes</CardTitle>
            <Monitor className="h-4 w-4 text-indigo-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900 dark:text-white">32 / 40</div>
            <p className="text-xs text-slate-500 dark:text-slate-400">+2 since last hour</p>
          </CardContent>
        </Card>
        <Card className="bg-white dark:bg-slate-800 border-none shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-slate-500 dark:text-slate-400">Avg Productivity</CardTitle>
            <Activity className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900 dark:text-white">78.4%</div>
            <p className="text-xs text-emerald-500">+4.2% from yesterday</p>
          </CardContent>
        </Card>
        <Card className="bg-white dark:bg-slate-800 border-none shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-slate-500 dark:text-slate-400">Automation Alerts</CardTitle>
            <AlertTriangle className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900 dark:text-white">3</div>
            <p className="text-xs text-amber-500">Suspected mouse jigglers</p>
          </CardContent>
        </Card>
        <Card className="bg-white dark:bg-slate-800 border-none shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-slate-500 dark:text-slate-400">Locked Systems</CardTitle>
            <Shield className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900 dark:text-white">1</div>
            <p className="text-xs text-slate-500 dark:text-slate-400">Persistent lockdowns active</p>
          </CardContent>
        </Card>
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Charts Section */}
        <div className="lg:col-span-2 space-y-6">
          {/* Productivity Chart */}
          <Card className="bg-white dark:bg-slate-800 border-none shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg font-semibold text-slate-900 dark:text-white">Productivity Trend</CardTitle>
              <CardDescription className="text-slate-500 dark:text-slate-400">Hourly breakdown of productive vs unproductive time</CardDescription>
            </CardHeader>
            <CardContent className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={productivityData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorProd" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.8} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="colorUnprod" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.8} />
                      <stop offset="95%" stopColor="#f43f5e" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-slate-100 dark:stroke-slate-700" />
                  <XAxis dataKey="time" className="text-xs text-slate-500" />
                  <YAxis className="text-xs text-slate-500" />
                  <Tooltip />
                  <Area
                    type="monotone"
                    dataKey="productive"
                    stroke="#6366f1"
                    fillOpacity={1}
                    fill="url(#colorProd)"
                    strokeWidth={2}
                  />
                  <Area
                    type="monotone"
                    dataKey="unproductive"
                    stroke="#f43f5e"
                    fillOpacity={1}
                    fill="url(#colorUnprod)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* App Usage and Timeline Row */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* App Usage Pie */}
            <Card className="bg-white dark:bg-slate-800 border-none shadow-sm">
              <CardHeader>
                <CardTitle className="text-lg font-semibold text-slate-900 dark:text-white">Top Applications</CardTitle>
              </CardHeader>
              <CardContent className="h-[200px] flex justify-center items-center">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={computedAppUsage}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={80}
                      paddingAngle={5}
                      dataKey="value"
                    >
                      {computedAppUsage.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex flex-col gap-2 text-xs">
                  {computedAppUsage.map((item) => (
                    <div key={item.name} className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }} />
                      <span className="text-slate-700 dark:text-slate-300 font-medium">{item.name}</span>
                      <span className="text-slate-400">{item.value}%</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Input Activity */}
            <Card className="bg-white dark:bg-slate-800 border-none shadow-sm">
              <CardHeader>
                <CardTitle className="text-lg font-semibold text-slate-900 dark:text-white">Input Entropy</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <MousePointer className="h-4 w-4 text-indigo-500" />
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Mouse Velocity</span>
                  </div>
                  <Badge variant="outline" className="text-emerald-500 border-emerald-200 bg-emerald-50">High Variance</Badge>
                </div>
                <div className="w-full bg-slate-100 dark:bg-slate-700 h-2 rounded-full overflow-hidden">
                  <div className="bg-indigo-500 h-full w-[75%]" />
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Keyboard className="h-4 w-4 text-indigo-500" />
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Keystroke Rhythm</span>
                  </div>
                  <Badge variant="outline" className="text-emerald-500 border-emerald-200 bg-emerald-50">Human Pattern</Badge>
                </div>
                <div className="w-full bg-slate-100 dark:bg-slate-700 h-2 rounded-full overflow-hidden">
                  <div className="bg-indigo-500 h-full w-[60%]" />
                </div>
                
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Real-time pattern analysis indicates a human user. No automation detected on active node.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Device Monitor Section */}
        <div className="lg:col-span-1">
          <Card className="bg-white dark:bg-slate-800 border-none shadow-sm h-full">
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-lg font-semibold text-slate-900 dark:text-white">Live Nodes</CardTitle>
                <CardDescription className="text-slate-500 dark:text-slate-400">Active monitoring agents</CardDescription>
              </div>
              <Badge variant="outline" className="text-indigo-600 border-indigo-200 bg-indigo-50">
                {devices.length} Total
              </Badge>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {devices.map((device) => (
                  <div key={device.id} className="p-3 border border-slate-100 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-750 transition-colors">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${
                          device.status === "online" ? "bg-emerald-500" : 
                          device.status === "idle" ? "bg-amber-500" : "bg-slate-400"
                        }`} />
                        <span className="font-medium text-slate-900 dark:text-white text-sm">{device.name}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        {device.automation && (
                          <Badge variant="destructive" className="text-[10px] px-1.5 py-0">Fake Detected</Badge>
                        )}
                        {device.isLocked && (
                          <Badge className="text-[10px] px-1.5 py-0 bg-red-500">Locked</Badge>
                        )}
                      </div>
                    </div>
                    
                    <div className="flex justify-between items-center text-xs text-slate-500 dark:text-slate-400 mb-3">
                      <span>{device.user}</span>
                      <span>{device.lastSeen}</span>
                    </div>

                    <div className="flex justify-between items-center text-xs mb-3">
                      <span className="text-slate-500">Productivity:</span>
                      <span className={`font-semibold ${
                        device.productivity >= 80 ? "text-emerald-500" :
                        device.productivity >= 50 ? "text-amber-500" : "text-red-500"
                      }`}>{device.productivity}%</span>
                    </div>

                    {/* Quick Actions */}
                    <div className="flex gap-2 justify-end">
                      <Button size="sm" variant="outline" className="h-7 text-xs px-2" title="Stealth Camera">
                        <Camera className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 text-xs px-2" title="Capture Screenshot">
                        <Monitor className="h-3.5 w-3.5" />
                      </Button>
                      <Button 
                        size="sm" 
                        variant={device.isLocked ? "destructive" : "outline"} 
                        className="h-7 text-xs px-2" 
                        title={device.isLocked ? "Unlock System" : "Lockdown System"}
                      >
                        <Power className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default Preview;
