import * as React from "react";
import { Calendar, Clock, User, CheckCircle, XCircle, AlertCircle, Save, Settings as SettingsIcon, ChevronLeft, ChevronRight, Search, RotateCcw, Monitor, Timer, LogOut, XCircle as XIcon, ChevronDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppStore } from "../../store";
import { Badge } from "@/components/ui/badge";
import { attendanceApi } from "../../lib/api";

interface AttendanceRecord {
  deviceId: string;
  name: string;
  user: string;
  status: "Present" | "Half Day" | "Absent";
  reason: string;
  totalHours: number;
  firstSeen: string;
  lastSeen: string;
  required: number;
}


interface AttendanceSettings {
  startTime: string;
  halfDayStartThreshold: string;
  halfDayOffStart: string;
  halfDayOffEnd: string;
  requiredHoursNormal: number;
  requiredHoursFriday: number;
}

export default function Attendance() {
  const { devices } = useAppStore();
  const [date, setDate] = React.useState(new Date().toISOString().split("T")[0]);
  const [records, setRecords] = React.useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [showSettings, setShowSettings] = React.useState(false);
  const [settings, setSettings] = React.useState<AttendanceSettings>({
    startTime: "08:00",
    halfDayStartThreshold: "09:00",
    halfDayOffStart: "12:00",
    halfDayOffEnd: "15:00",
    requiredHoursNormal: 7.5,
    requiredHoursFriday: 7.0
  });
  const [savedSettings, setSavedSettings] = React.useState(false);
  const [selectedDeviceForSettings, setSelectedDeviceForSettings] = React.useState("global");
  const [searchQuery, setSearchQuery] = React.useState("");
  const [deviceSearch, setDeviceSearch] = React.useState("");
  const [settingsGroupFilter, setSettingsGroupFilter] = React.useState<string>("all");
  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);
  const [groupFilter, setGroupFilter] = React.useState<string>("all");

  const allGroups = React.useMemo(() => Array.from(new Set(devices.map(d => d.deviceGroup || "Unassigned"))).sort(), [devices]);



  // Add this helper function
  const calculateHours = (firstSeen: string, lastSeen: string): number => {
    if (!firstSeen || firstSeen === "-" || !lastSeen || lastSeen === "-") return 0;

    const [firstHour, firstMin] = firstSeen.split(":").map(Number);
    const [lastHour, lastMin] = lastSeen.split(":").map(Number);

    let hours = lastHour - firstHour;
    let minutes = lastMin - firstMin;

    if (minutes < 0) {
      hours -= 1;
      minutes += 60;
    }

    return hours + minutes / 60;
  };

  const fetchAttendance = React.useCallback(async () => {
    setLoading(true);
    try {
      const data = await attendanceApi.report(date);
      setRecords(data);
    } catch (err) {
      console.error("Failed to fetch attendance:", err);
    } finally {
      setLoading(false);
    }
  }, [date]);

  const filteredRecords = React.useMemo(() => {
    if (!Array.isArray(records)) return [];

    return records.filter(r => {
      const q = searchQuery.toLowerCase();
      const matchSearch = !searchQuery ||
        (r.name?.toLowerCase().includes(q)) ||
        (r.user?.toLowerCase().includes(q)) ||
        (r.deviceId?.toLowerCase().includes(q));

      const parentDevice = devices.find((d: any) => d.id === r.deviceId);
      const parentGroup = parentDevice?.deviceGroup || "Unassigned";
      const matchGroup = groupFilter === "all" || parentGroup === groupFilter;

      return matchSearch && matchGroup;
    });
  }, [records, searchQuery, groupFilter, devices]);

  const fetchSettings = React.useCallback(async (deviceId: string) => {
    try {
      const data = await attendanceApi.getSettings(deviceId);
      if (data) setSettings(data);
    } catch (err) {
      console.error("Failed to fetch attendance settings:", err);
    }
  }, []);

  React.useEffect(() => {
    fetchAttendance();
  }, [fetchAttendance]);

  React.useEffect(() => {
    if (showSettings) {
      const targetId = selectedIds.length === 1 ? selectedIds[0] : selectedDeviceForSettings;
      fetchSettings(targetId);
    }
  }, [showSettings, selectedIds, selectedDeviceForSettings, fetchSettings]);

  const handleSaveSettings = async () => {
    try {
      const targets = selectedIds.length > 0 ? selectedIds : [selectedDeviceForSettings];

      setLoading(true);
      await Promise.all(targets.map(id =>
        attendanceApi.saveSettings({ deviceId: id, ...settings as any })
      ));

      // Optimistically update UI statuses for affected devices using the new settings
      setRecords(prev => {
        return prev.map(r => targets.includes(r.deviceId) ? (computeStatusForRecord(r, settings) as any) : r);
      });

      setSavedSettings(true);
      setTimeout(() => setSavedSettings(false), 2000);

      // Refresh report from server to ensure canonical data
      fetchAttendance();
    } catch (err) {
      console.error("Failed to save settings:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleResetToGlobal = async () => {
    try {
      const data = await attendanceApi.getSettings("global");
      if (data) setSettings(data);
    } catch (err) {
      console.error("Failed to reset to global:", err);
    }
  };

  const toggleSelectAll = () => {
    if (selectedIds.length === filteredRecords.length && filteredRecords.length > 0) {
      setSelectedIds([]);
    } else {
      setSelectedIds(filteredRecords.map(r => r.deviceId));
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "Present": return "bg-emerald-500/10 text-emerald-600 border-emerald-500/20";
      case "Half Day": return "bg-amber-500/10 text-amber-600 border-amber-500/20";
      case "Absent": return "bg-red-500/10 text-red-600 border-red-500/20";
      default: return "bg-slate-500/10 text-slate-600 border-slate-500/20";
    }
  };
  const getDeviceNameOnly = (id: string) => {
    const dev = devices.find((d: any) => d.id === id);
    return dev ? dev.name : id;
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "Present": return <CheckCircle className="h-4 w-4" />;
      case "Half Day": return <AlertCircle className="h-4 w-4" />;
      case "Absent": return <XCircle className="h-4 w-4" />;
      default: return null;
    }
  };

  const getDeviceName = (id: string) => {
    const dev = devices.find((d: any) => d.id === id);
    return dev ? `${dev.name} (${dev.user})` : id;
  };

  const computeStatusForRecord = (rec: AttendanceRecord, sets: any) => {
    const dayOfWeek = new Date(date).getDay();
    const isFriday = dayOfWeek === 5;
    const required = isFriday ? (sets.requiredHoursFriday ?? 7.0) : (sets.requiredHoursNormal ?? 7.5);

    // If no logs, keep absent
    if (!rec.firstSeen || rec.firstSeen === "-" || !rec.lastSeen || rec.lastSeen === "-") {
      return { ...rec, status: "Absent", reason: "No tracker data for this date.", required };
    }

    const firstTime = rec.firstSeen;
    const lastTime = rec.lastSeen;
    let status: AttendanceRecord['status'] = "Present";
    let reason = "";

    if (firstTime > (sets.halfDayStartThreshold || "09:00")) {
      status = "Half Day";
      reason = `Late start (${firstTime} > ${sets.halfDayStartThreshold})`;
    }

    if (lastTime < (sets.halfDayOffStart || "12:00")) {
      status = "Half Day";
      reason = `Early departure (${lastTime} < ${sets.halfDayOffStart})`;
    }

    // Rule 3: Insufficient Hours (Only apply if they have checked out early OR it's a previous day)
    const now = new Date();
    const isToday = date === now.toISOString().split("T")[0];
    const currentTimeStr = now.toTimeString().split(' ')[0].substring(0, 5); // "HH:MM"

    // Only count as departure if they stopped BEFORE the threshold AND the current time IS AFTER the threshold
    // OR if it's a previous day.
    const hasCheckedOutEarly = isToday
      ? (lastTime < (sets.halfDayOffStart || "12:00") && currentTimeStr > (sets.halfDayOffStart || "12:00"))
      : (lastTime < (sets.halfDayOffStart || "12:00"));

    if (status === "Present" && (rec.totalHours || 0) < required) {
      // If it's a previous day or they checked out before the threshold, they get Half Day
      if (!isToday || hasCheckedOutEarly) {
        status = "Half Day";
        reason = `Insufficient hours (${rec.totalHours}/${required}h)`;
      }
    }

    // Final override for "In Time" during the morning
    if (isToday && firstTime <= sets.halfDayStartThreshold && !hasCheckedOutEarly) {
      status = "Present";
      reason = "On shift (Meeting policy)";
    }

    return { ...rec, status, reason, required } as AttendanceRecord & { required: number; reason: string };
  };

  return (
    <div className="space-y-6 max-w-6xl pb-20">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">Attendance Report</h1>
          <p className="text-slate-500 text-sm">Monitor employee working hours and presence thresholds</p>
        </div>

        <div className="flex items-center gap-3">
          {selectedIds.length > 0 && (
            <Badge variant="secondary" className="bg-indigo-50 text-indigo-700 border-indigo-100 flex items-center gap-1">
              {selectedIds.length} Nodes Selected
              <button onClick={() => setSelectedIds([])} className="ml-1 hover:text-indigo-900">
                <XIcon className="h-3 w-3" />
              </button>
            </Badge>
          )}
          <div className="flex items-center bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-1 px-2 shadow-sm">
            <button
              onClick={() => {
                const prev = new Date(date);
                prev.setDate(prev.getDate() - 1);
                setDate(prev.toISOString().split("T")[0]);
              }}
              className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md text-slate-500 transition-colors"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="border-none shadow-none focus-visible:ring-0 w-36 bg-transparent h-8 text-xs font-semibold"
            />
            <button
              onClick={() => {
                const next = new Date(date);
                next.setDate(next.getDate() + 1);
                setDate(next.toISOString().split("T")[0]);
              }}
              className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md text-slate-500 transition-colors"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="relative group">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 group-focus-within:text-indigo-500 transition-colors" />
            <input
              type="text"
              placeholder="Search employee..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 pr-4 h-9 w-[180px] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs outline-none focus:ring-1 focus:ring-indigo-500 transition-all font-medium shadow-sm"
            />
          </div>
          <select
            className="h-9 w-[140px] text-xs font-medium bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-3 shadow-sm outline-none focus:ring-1 focus:ring-indigo-500 text-slate-700 dark:text-slate-300"
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
          >
            <option value="all">All Groups</option>
            {allGroups.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowSettings(!showSettings)}
            className={`h-9 shadow-sm ${showSettings ? "bg-indigo-50 border-indigo-200 text-indigo-700 dark:bg-indigo-900/20" : ""}`}
          >
            <SettingsIcon className="h-4 w-4 mr-2" />
            Config Thresholds
          </Button>
        </div>
      </div>

      {/* Modern Legend */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {[
          { icon: <CheckCircle className="h-4 w-4" />, title: "Regular Presence", desc: "Met daily hours and shift start thresholds.", color: "emerald" },
          { icon: <AlertCircle className="h-4 w-4" />, title: "Half Day Triggers", desc: "Late start, early exit, or insufficient hours.", color: "amber" },
          { icon: <XCircle className="h-4 w-4" />, title: "Absentia", desc: "No tracker data received for this date.", color: "red" }
        ].map((item, i) => (
          <Card key={i} className={`bg-${item.color}-50/50 dark:bg-${item.color}-500/5 border-${item.color}-100 dark:border-${item.color}-500/10 shadow-sm border-2`}>
            <CardContent className="pt-5 flex items-start gap-4">
              <div className={`p-2.5 bg-${item.color}-500 text-white rounded-xl shadow-lg shadow-${item.color}-500/20`}>
                {item.icon}
              </div>
              <div className="space-y-1">
                <p className={`text-xs font-black text-${item.color}-700 dark:text-${item.color}-400 uppercase tracking-widest`}>{item.title}</p>
                <p className={`text-[11px] font-medium text-${item.color}-600/80 leading-relaxed`}>{item.desc}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {showSettings && (
        <Card className="border-none shadow-xl bg-white dark:bg-slate-900 animate-in slide-in-from-top-4 duration-300 ring-1 ring-slate-200 dark:ring-slate-800">
          <CardHeader className="pb-4 border-b border-slate-50 dark:border-slate-800/50">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-indigo-50 dark:bg-indigo-900/30 rounded-lg">
                  <SettingsIcon className="h-5 w-5 text-indigo-600" />
                </div>
                <div>
                  <CardTitle className="text-base text-slate-900 dark:text-white">
                    Attendance Policy Logic
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Define thresholds and daily active hour requirements
                  </CardDescription>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowSettings(false)}
                className="h-8 w-8 p-0 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg"
              >
                <XIcon className="h-4 w-4" />
              </Button>
            </div>

            <div className="space-y-4">
              <div className="flex flex-col md:flex-row md:items-start gap-4">
                <div className="flex-1 space-y-2">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-1">Select Devices to Configure</label>
                  <div className="flex gap-2">
                    <div className="relative group flex-1">
                      <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400 group-focus-within:text-indigo-500 transition-colors" />
                      <Input
                        placeholder="Search nodes or employees..."
                        value={deviceSearch}
                        onChange={(e) => setDeviceSearch(e.target.value)}
                        className="pl-9 h-9 text-xs bg-slate-50/50 dark:bg-white/5 border-slate-200 dark:border-slate-800 focus:ring-indigo-500/20"
                      />
                    </div>
                    <select
                      className="h-9 w-28 text-[11px] font-medium bg-slate-50/50 dark:bg-white/5 border border-slate-200 dark:border-slate-800 rounded-md px-2 focus:ring-indigo-500/20 text-slate-700 dark:text-slate-300 outline-none transition-colors"
                      value={settingsGroupFilter}
                      onChange={(e) => setSettingsGroupFilter(e.target.value)}
                    >
                      <option value="all">All Groups</option>
                      {allGroups.map((g) => (
                        <option key={g} value={g}>{g}</option>
                      ))}
                    </select>
                  </div>
                  <div className="h-28 overflow-y-auto border border-slate-100 dark:border-slate-800 rounded-lg p-2 bg-slate-50/30 dark:bg-black/5 space-y-1 custom-scrollbar">
                    <div
                      onClick={() => {
                        setSelectedIds([]);
                        setSelectedDeviceForSettings("global");
                      }}
                      className={`flex items-center gap-2 p-1.5 rounded-md cursor-pointer transition-colors ${selectedIds.length === 0 && selectedDeviceForSettings === "global" ? "bg-indigo-600 text-white shadow-sm" : "hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400"}`}
                    >
                      <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center ${selectedIds.length === 0 && selectedDeviceForSettings === "global" ? "border-white bg-white" : "border-slate-300 dark:border-slate-600"}`}>
                        {(selectedIds.length === 0 && selectedDeviceForSettings === "global") && <CheckCircle className="h-2.5 w-2.5 text-indigo-600 fill-indigo-600" />}
                      </div>
                      <span className="text-[11px] font-bold">GLOBAL (All Nodes)</span>
                    </div>
                    {devices.filter((d: any) => {
                      const matchSearch = !deviceSearch || d.name.toLowerCase().includes(deviceSearch.toLowerCase()) || d.user.toLowerCase().includes(deviceSearch.toLowerCase());
                      const matchGroup = settingsGroupFilter === "all" || (d.deviceGroup || "Unassigned") === settingsGroupFilter;
                      return matchSearch && matchGroup;
                    }).map((d: any) => (
                      <div
                        key={d.id}
                        onClick={() => toggleSelect(d.id)}
                        className={`flex items-center gap-2 p-1.5 rounded-md cursor-pointer transition-colors ${selectedIds.includes(d.id) ? "bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300" : "hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400"}`}
                      >
                        <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center ${selectedIds.includes(d.id) ? "border-indigo-500 bg-indigo-500" : "border-slate-300 dark:border-slate-600"}`}>
                          {selectedIds.includes(d.id) && <CheckCircle className="h-2.5 w-2.5 text-white" />}
                        </div>
                        <span className="text-[11px] font-medium">{d.name} <span className="text-[9px] opacity-60">({d.user})</span></span>
                        <span className="ml-auto text-[9px] font-bold text-slate-400 dark:text-slate-500 px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 uppercase max-w-[60px] truncate">{d.deviceGroup || "Unassigned"}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="w-[320px] space-y-2">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-1">Applying To</label>
                  <div className="min-h-[148px] p-3 border border-slate-100 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900/50 flex flex-wrap gap-2 content-start overflow-y-auto max-h-[148px] shadow-inner">
                    {selectedIds.length === 0 ? (
                      <div className="flex flex-col items-center justify-center w-full h-full text-center space-y-2 py-4">
                        <Badge className="bg-indigo-600 py-1 px-3">GLOBAL DEFAULT</Badge>
                        <p className="text-[10px] text-slate-400 italic">Settings will apply to all nodes without specific overrides.</p>
                      </div>
                    ) : (
                      <>
                        {selectedIds.map(id => (
                          <div key={id} className="flex items-center gap-1.5 pl-2.5 pr-1 py-1 bg-indigo-50 dark:bg-indigo-900/40 rounded-full border border-indigo-100 dark:border-indigo-800 shadow-sm animate-in zoom-in-95 duration-200">
                            <span className="text-[10px] font-bold text-indigo-700 dark:text-indigo-300">{getDeviceNameOnly(id)}</span>
                            <button
                              onClick={(e) => { e.stopPropagation(); toggleSelect(id); }}
                              className="p-0.5 hover:bg-white dark:hover:bg-slate-800 rounded-full text-indigo-400 hover:text-red-500 transition-colors"
                            >
                              <XIcon className="h-2.5 w-2.5" />
                            </button>
                          </div>
                        ))}
                        <div className="w-full mt-2 pt-2 border-t border-slate-50 dark:border-slate-800/50 flex justify-between items-center">
                          <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">{selectedIds.length} Nodes selected</p>
                          <button
                            onClick={() => setSelectedIds([])}
                            className="text-[9px] font-black text-rose-500 hover:text-rose-700 uppercase tracking-widest py-1.5 px-2"
                          >
                            Clear Selection
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8 pb-8">
              <div className="space-y-4">
                <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
                  <Timer className="h-3.5 w-3.5 text-indigo-500" /> Entry Thresholds
                </h4>
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-slate-600 dark:text-slate-400">Regular Shift Start</label>
                    <Input type="time" value={settings.startTime} onChange={(e) => setSettings({ ...settings, startTime: e.target.value })} className="bg-slate-50/50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-slate-600 dark:text-slate-400">Late Start (Half-Day)</label>
                    <Input type="time" value={settings.halfDayStartThreshold} onChange={(e) => setSettings({ ...settings, halfDayStartThreshold: e.target.value })} className="bg-slate-50/50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700" />
                    <p className="text-[9px] text-slate-400 italic">Marked as half-day if check-in after this time</p>
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
                  <LogOut className="h-3.5 w-3.5 text-amber-500" /> Departure Threshold
                </h4>
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-slate-600 dark:text-slate-400">Half-Day End Threshold</label>
                    <Input type="time" value={settings.halfDayOffStart} onChange={(e) => setSettings({ ...settings, halfDayOffStart: e.target.value })} className="bg-slate-50/50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700" />
                    <p className="text-[9px] text-slate-400 italic">Marked as half-day if check-out before this time</p>
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
                  <Monitor className="h-3.5 w-3.5 text-emerald-500" /> Target Daily Hours
                </h4>
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-slate-600 dark:text-slate-400">Mon-Thu (Required)</label>
                    <div className="relative">
                      <Input type="number" step="0.1" value={settings.requiredHoursNormal} onChange={(e) => setSettings({ ...settings, requiredHoursNormal: parseFloat(e.target.value) })} className="bg-slate-50/50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700 pr-10" />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[9px] font-black text-slate-400">HRS</span>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-slate-600 dark:text-slate-400">Friday (Required)</label>
                    <div className="relative">
                      <Input type="number" step="0.1" value={settings.requiredHoursFriday} onChange={(e) => setSettings({ ...settings, requiredHoursFriday: parseFloat(e.target.value) })} className="bg-slate-50/50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700 pr-10" />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[9px] font-black text-slate-400">HRS</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="pt-6 border-t border-slate-100 dark:border-slate-800/50 flex flex-col sm:flex-row items-center justify-between gap-4">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleResetToGlobal}
                className="text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 text-[11px] font-bold uppercase tracking-wider flex items-center gap-1.5 transition-all"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset Form to Global Defaults
              </Button>
              <div className="flex items-center gap-6">
                <div className="text-right hidden sm:block">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Active Policy:</p>
                  <p className="text-xs font-semibold text-slate-600 dark:text-slate-400">Mon-Thu {settings.requiredHoursNormal}h • Fri {settings.requiredHoursFriday}h</p>
                </div>
                <Button onClick={handleSaveSettings} size="sm" className="bg-indigo-600 hover:bg-indigo-700 shadow-md px-6">
                  <Save className="h-4 w-4 mr-2" />
                  {savedSettings ? "Applied and Saved!" : "Apply Policy Settings"}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Attendance Table */}
      <Card className="border-none shadow-sm overflow-hidden bg-white dark:bg-slate-900 ring-1 ring-slate-200 dark:ring-slate-800">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50/50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800">
                  <th className="px-6 py-4 w-10">
                    <input
                      type="checkbox"
                      className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                      checked={filteredRecords.length > 0 && selectedIds.length === filteredRecords.length}
                      onChange={toggleSelectAll}
                    />
                  </th>
                  <th className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-slate-400">Employee / Node</th>
                  <th className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-slate-400">Status</th>
                  <th className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-slate-400 text-center">First Seen</th>
                  <th className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-slate-400 text-center">Last Seen</th>
                  <th className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-slate-400 text-center">Active Hours</th>
                  <th className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-slate-400">Audit Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {loading && filteredRecords.length === 0 ? (
                  [...Array(3)].map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      <td className="px-6 py-4"></td>
                      <td colSpan={6} className="px-6 py-8 bg-slate-50/20 dark:bg-slate-800/10"></td>
                    </tr>
                  ))
                ) : !Array.isArray(records) ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-red-500 font-medium">
                      Error: Received invalid data from server. {(records as any)?.error || "Checking API connection..."}
                    </td>
                  </tr>
                ) : records.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-slate-500">No activity recorded for this date.</td>
                  </tr>
                ) : filteredRecords.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-slate-500">
                      No results matching "{searchQuery}"
                    </td>
                  </tr>
                ) : (
                  filteredRecords.map((rec) => (
                    <tr key={rec.deviceId} className={`${selectedIds.includes(rec.deviceId) ? "bg-indigo-50/40 dark:bg-indigo-900/10" : "hover:bg-slate-50/50 dark:hover:bg-slate-800/30"} transition-colors group`}>
                      <td className="px-6 py-4">
                        <input
                          type="checkbox"
                          className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                          checked={selectedIds.includes(rec.deviceId)}
                          onChange={() => toggleSelect(rec.deviceId)}
                        />
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center border border-slate-200/50 dark:border-slate-700/50 group-hover:scale-105 transition-transform shadow-sm">
                            <User className="h-4 w-4 text-slate-500" />
                          </div>
                          <div>
                            <p className="text-sm font-bold text-slate-900 dark:text-white leading-tight">{rec.user}</p>
                            <p className="text-[10px] font-bold text-indigo-500/80 uppercase tracking-tight">{rec.name}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-black border uppercase tracking-wider ${getStatusColor(rec.status)}`}>
                          {getStatusIcon(rec.status)}
                          {rec.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <span className="text-xs font-mono font-bold text-slate-600 dark:text-slate-400">{rec.firstSeen}</span>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <span className="text-xs font-mono font-bold text-slate-600 dark:text-slate-400">{rec.lastSeen}</span>
                      </td>
                      <td className="px-6 py-4 text-center">
                        {(() => {
                          const calculatedHours = calculateHours(rec.firstSeen, rec.lastSeen);
                          return (
                            <div className="flex flex-col items-center">
                              <div className="text-sm font-black text-slate-900 dark:text-white">
                                {calculatedHours.toFixed(1)}h
                              </div>
                              <div className="w-16 h-1 bg-slate-100 dark:bg-slate-800 rounded-full mt-1.5 overflow-hidden ring-1 ring-slate-200/50 dark:ring-slate-700/50">
                                <div
                                  className={`h-full rounded-full transition-all duration-500 ${calculatedHours >= rec.required ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]" : "bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.4)]"}`}
                                  style={{ width: `${Math.min((calculatedHours / rec.required) * 100, 100)}%` }}
                                />
                              </div>
                              <p className="text-[9px] font-bold text-slate-400 mt-1 uppercase tracking-tighter">of {rec.required}h target</p>
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-6 py-4">
                        <p className="text-xs text-slate-500 italic max-w-[200px] leading-relaxed line-clamp-2">{rec.reason || "Policy fully compliant"}</p>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>


    </div>
  );
}
