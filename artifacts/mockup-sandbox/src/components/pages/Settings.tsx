import * as React from "react";
import { Shield, Bell, Clock, Camera, Database, Save, CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function Settings() {
  const [saved, setSaved] = React.useState(false);
  const [screenshotMin, setScreenshotMin] = React.useState(5);
  const [screenshotMax, setScreenshotMax] = React.useState(15);
  const [idleThreshold, setIdleThreshold] = React.useState(2);
  const [syncInterval, setSyncInterval] = React.useState(5);
  const [retentionDays, setRetentionDays] = React.useState(30);

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">Settings</h1>
        <p className="text-slate-500 text-sm">Global monitoring configuration applied to all nodes</p>
      </div>

      {/* Screenshot Settings */}
      <Card className="border-none shadow-sm bg-white dark:bg-slate-800">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Camera className="h-4 w-4 text-indigo-500" /> Screenshot Capture
          </CardTitle>
          <CardDescription className="text-xs">Configure random screenshot intervals</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Min Interval (min)</label>
              <Input type="number" value={screenshotMin} min={1} max={60} onChange={(e) => setScreenshotMin(+e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Max Interval (min)</label>
              <Input type="number" value={screenshotMax} min={1} max={120} onChange={(e) => setScreenshotMax(+e.target.value)} />
            </div>
          </div>
          <p className="text-xs text-slate-500">
            Screenshots will be captured at a random interval between {screenshotMin}–{screenshotMax} minutes per device.
          </p>
        </CardContent>
      </Card>

      {/* Activity Settings */}
      <Card className="border-none shadow-sm bg-white dark:bg-slate-800">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4 text-indigo-500" /> Activity Detection
          </CardTitle>
          <CardDescription className="text-xs">Configure idle and sync thresholds</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Idle Threshold (minutes)</label>
            <Input type="number" value={idleThreshold} min={1} max={30} onChange={(e) => setIdleThreshold(+e.target.value)} />
            <p className="text-xs text-slate-500">Mark a device as idle after {idleThreshold} minute(s) of no input.</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Sync Interval (minutes)</label>
            <Input type="number" value={syncInterval} min={1} max={60} onChange={(e) => setSyncInterval(+e.target.value)} />
            <p className="text-xs text-slate-500">How often agents send data back to the server.</p>
          </div>
        </CardContent>
      </Card>

      {/* Data Retention */}
      <Card className="border-none shadow-sm bg-white dark:bg-slate-800">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Database className="h-4 w-4 text-indigo-500" /> Data Retention
          </CardTitle>
          <CardDescription className="text-xs">Control how long logs and screenshots are kept</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-700 dark:text-slate-300">Retention Period (days)</label>
            <Input type="number" value={retentionDays} min={7} max={365} onChange={(e) => setRetentionDays(+e.target.value)} />
          </div>
          <p className="text-xs text-slate-500">
            Activity logs and screenshots older than {retentionDays} days will be automatically purged.
          </p>
        </CardContent>
      </Card>

      {/* Save */}
      <div className="flex items-center gap-3">
        <Button onClick={handleSave} className="bg-indigo-600 hover:bg-indigo-700 text-white px-6">
          <Save className="h-4 w-4 mr-2" />
          Save Settings
        </Button>
        {saved && (
          <span className="flex items-center gap-1.5 text-sm text-emerald-600 font-medium animate-in fade-in">
            <CheckCircle2 className="h-4 w-4" /> Saved successfully!
          </span>
        )}
      </div>
    </div>
  );
}
