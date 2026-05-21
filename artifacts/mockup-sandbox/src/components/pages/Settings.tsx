import * as React from "react";
import { Shield, Bell, Clock, Camera, Database, Save, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppStore, Device } from "../../store";
import { settingsApi } from "../../lib/api";

export default function Settings() {
  const [saved, setSaved] = React.useState(false);
  const [screenshotMin, setScreenshotMin] = React.useState(5);
  const [screenshotMax, setScreenshotMax] = React.useState(15);
  const [idleThreshold, setIdleThreshold] = React.useState(2);
  const [syncInterval, setSyncInterval] = React.useState(5);
  const [screenshotUnit, setScreenshotUnit] = React.useState("min");
  const [activityUnit, setActivityUnit] = React.useState("min");

  const { devices } = useAppStore();
  const [targetDeviceId, setTargetDeviceId] = React.useState("global");

  // Fetch settings for the chosen device target
  React.useEffect(() => {
    settingsApi.get(targetDeviceId)
      .then((data) => {
        if (data) {
          setScreenshotMin(data.screenshotMin ?? 5);
          setScreenshotMax(data.screenshotMax ?? 15);
          setIdleThreshold(data.idleThreshold ?? 2);
          setSyncInterval(data.syncInterval ?? 5);
          setScreenshotUnit(data.screenshotUnit ?? "min");
          setActivityUnit(data.activityUnit ?? "min");
        }
      })
      .catch((err) => console.error("Error loading device settings:", err));
  }, [targetDeviceId]);

  const handleSave = () => {
    settingsApi.save({
      deviceId: targetDeviceId,
      screenshotMin,
      screenshotMax,
      idleThreshold,
      syncInterval,
      screenshotUnit,
      activityUnit,
    })
      .then(() => {
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      })
      .catch((err) => console.error("Error saving device settings:", err));
  };

  return (
    <div className="space-y-6 max-w-2xl pb-20">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">Settings</h1>
        <p className="text-slate-500 text-sm">Configure tracker parameters globally or for individual nodes</p>
      </div>

      {/* Target Node Selector */}
      <Card className="border-none shadow-sm bg-white dark:bg-slate-800">
        <CardContent className="pt-6 space-y-2">
          <label className="text-xs font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">Target Node Configuration</label>
          <select
            value={targetDeviceId}
            onChange={(e) => setTargetDeviceId(e.target.value)}
            className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          >
            <option value="global">🌐 Global Baseline (Default settings for all nodes)</option>
            {devices.map((device: Device) => (
              <option key={device.id} value={device.id}>
                🖥️ {device.name} — {device.user} ({device.id})
              </option>
            ))}
          </select>
          <p className="text-xs text-slate-500">
            {targetDeviceId === "global" 
              ? "All registered employee client nodes will inherit these default settings automatically." 
              : `These override settings will be applied specifically to this machine.`}
          </p>
        </CardContent>
      </Card>

      {/* Screenshot Settings */}
      <Card className="border-none shadow-sm bg-white dark:bg-slate-800">
        <CardHeader>
          <div className="flex justify-between items-start">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Camera className="h-4 w-4 text-indigo-500" /> Screenshot Capture
              </CardTitle>
              <CardDescription className="text-xs">Configure random screenshot intervals</CardDescription>
            </div>
            <div className="flex bg-slate-100 dark:bg-slate-900 p-1 rounded-lg">
               <button 
                 onClick={() => setScreenshotUnit("sec")}
                 className={`px-3 py-1 text-[10px] font-bold rounded-md transition-all ${screenshotUnit === "sec" ? "bg-white dark:bg-slate-800 shadow-sm text-indigo-600" : "text-slate-500"}`}
               >SEC</button>
               <button 
                 onClick={() => setScreenshotUnit("min")}
                 className={`px-3 py-1 text-[10px] font-bold rounded-md transition-all ${screenshotUnit === "min" ? "bg-white dark:bg-slate-800 shadow-sm text-indigo-600" : "text-slate-500"}`}
               >MIN</button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-700 dark:text-slate-300 capitalize">Min Interval ({screenshotUnit})</label>
              <Input type="number" value={screenshotMin} min={1} onChange={(e) => setScreenshotMin(+e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-700 dark:text-slate-300 capitalize">Max Interval ({screenshotUnit})</label>
              <Input type="number" value={screenshotMax} min={1} onChange={(e) => setScreenshotMax(+e.target.value)} />
            </div>
          </div>
          <p className="text-xs text-slate-500">
            Screenshots will be captured at a random interval between {screenshotMin}–{screenshotMax} {screenshotUnit === "min" ? "minutes" : "seconds"} per device.
          </p>
        </CardContent>
      </Card>

      {/* Activity Settings */}
      <Card className="border-none shadow-sm bg-white dark:bg-slate-800">
        <CardHeader>
          <div className="flex justify-between items-start">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Clock className="h-4 w-4 text-indigo-500" /> Activity Detection
              </CardTitle>
              <CardDescription className="text-xs">Configure idle and sync thresholds</CardDescription>
            </div>
            <div className="flex bg-slate-100 dark:bg-slate-900 p-1 rounded-lg">
               <button 
                 onClick={() => setActivityUnit("sec")}
                 className={`px-3 py-1 text-[10px] font-bold rounded-md transition-all ${activityUnit === "sec" ? "bg-white dark:bg-slate-800 shadow-sm text-indigo-600" : "text-slate-500"}`}
               >SEC</button>
               <button 
                 onClick={() => setActivityUnit("min")}
                 className={`px-3 py-1 text-[10px] font-bold rounded-md transition-all ${activityUnit === "min" ? "bg-white dark:bg-slate-800 shadow-sm text-indigo-600" : "text-slate-500"}`}
               >MIN</button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Idle Threshold ({activityUnit === "min" ? "minutes" : "seconds"})</label>
            <Input type="number" value={idleThreshold} min={1} onChange={(e) => setIdleThreshold(+e.target.value)} />
            <p className="text-xs text-slate-500">Mark a device as idle after {idleThreshold} {activityUnit === "min" ? "minute(s)" : "second(s)"} of no input.</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Sync Interval ({activityUnit === "min" ? "minutes" : "seconds"})</label>
            <Input type="number" value={syncInterval} min={1} max={activityUnit === "min" ? 60 : 3600} onChange={(e) => setSyncInterval(+e.target.value)} />
            <p className="text-xs text-slate-500">How often agents send data back to the server in {activityUnit === "min" ? "minutes" : "seconds"}.</p>
          </div>
        </CardContent>
      </Card>

      {/* Save */}
      <div className="flex items-center gap-3 pt-4">
        <Button onClick={handleSave} className="bg-indigo-600 hover:bg-indigo-700 text-white px-8 h-11 transition-all">
          <Save className="h-4 w-4 mr-2" />
          Update All Settings
        </Button>
        {saved && (
          <span className="flex items-center gap-1.5 text-sm text-emerald-600 font-medium animate-in fade-in slide-in-from-left-2 transition-all">
            <CheckCircle2 className="h-5 w-5" /> Settings applied to {targetDeviceId === "global" ? "all nodes" : "this node"}!
          </span>
        )}
      </div>
    </div>
  );
}
