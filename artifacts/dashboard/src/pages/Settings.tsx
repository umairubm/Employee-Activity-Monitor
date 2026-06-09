import React, { useEffect, useState } from "react";
import {
  useListDevices,
  getListDevicesQueryKey,
  getGetDeviceQueryKey,
  useUpdateDeviceConfig,
  useApplyDeviceConfigToAll,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Settings as SettingsIcon, Camera, Clock, ShieldCheck, Save, Globe, MonitorSmartphone } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const ALL_TARGET = "__all__";

const DEFAULT_CONFIG = {
  monitoringEnabled: true,
  screenshotMinMinutes: 5,
  screenshotMaxMinutes: 15,
  idleThresholdSeconds: 120,
  syncIntervalSeconds: 300,
};

type ConfigForm = typeof DEFAULT_CONFIG;

export default function Settings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: devices, isLoading } = useListDevices({
    query: { queryKey: getListDevicesQueryKey() },
  });

  const [target, setTarget] = useState<string>(ALL_TARGET);
  const [form, setForm] = useState<ConfigForm>(DEFAULT_CONFIG);

  const updateConfig = useUpdateDeviceConfig();
  const applyAll = useApplyDeviceConfigToAll();
  const isSaving = updateConfig.isPending || applyAll.isPending;

  // When a specific device is selected, prefill the form from its current
  // config. "All devices" resets to the built-in defaults as a starting point.
  useEffect(() => {
    if (target === ALL_TARGET) {
      setForm(DEFAULT_CONFIG);
      return;
    }
    const device = devices?.find((d) => d.id === target);
    if (device) {
      setForm({
        monitoringEnabled: device.monitoringEnabled,
        screenshotMinMinutes: device.screenshotMinMinutes,
        screenshotMaxMinutes: device.screenshotMaxMinutes,
        idleThresholdSeconds: device.idleThresholdSeconds,
        syncIntervalSeconds: device.syncIntervalSeconds,
      });
    }
  }, [target, devices]);

  const setNum = (key: keyof ConfigForm) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value === "" ? 0 : Number(e.target.value);
    setForm((f) => ({ ...f, [key]: value }));
  };

  const handleSave = () => {
    if (form.screenshotMinMinutes > form.screenshotMaxMinutes) {
      toast({
        title: "Invalid screenshot interval",
        description: "Minimum interval must be less than or equal to the maximum.",
        variant: "destructive",
      });
      return;
    }

    const onError = (error: any) => {
      toast({ title: "Failed to save settings", description: error?.message, variant: "destructive" });
    };

    if (target === ALL_TARGET) {
      applyAll.mutate(
        { data: form },
        {
          onSuccess: (result) => {
            queryClient.invalidateQueries({ queryKey: getListDevicesQueryKey() });
            toast({
              title: "Settings applied",
              description: `Updated ${result.updated} device${result.updated === 1 ? "" : "s"}. Agents pick up changes on their next sync.`,
            });
          },
          onError,
        },
      );
    } else {
      updateConfig.mutate(
        { id: target, data: form },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListDevicesQueryKey() });
            queryClient.invalidateQueries({ queryKey: getGetDeviceQueryKey(target) });
            toast({
              title: "Settings saved",
              description: "The agent will apply the new configuration on its next sync.",
            });
          },
          onError,
        },
      );
    }
  };

  const targetDevice = devices?.find((d) => d.id === target);

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-2xl">
      <div>
        <div className="flex items-center gap-3 mb-2">
          <SettingsIcon className="h-6 w-6 text-primary" />
          <h1 className="text-3xl font-bold tracking-tight">Agent Settings</h1>
        </div>
        <p className="text-muted-foreground">
          Control how the desktop agents capture activity and screenshots. Changes
          take effect the next time each agent syncs with the server.
        </p>
      </div>

      {/* Target selector */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Apply to</CardTitle>
          <CardDescription>
            Apply these settings to every device, or override a single device.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Select value={target} onValueChange={setTarget} disabled={isLoading}>
            <SelectTrigger>
              <SelectValue placeholder="Select a target" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_TARGET}>
                <span className="flex items-center gap-2">
                  <Globe className="h-4 w-4" /> All devices
                </span>
              </SelectItem>
              {devices?.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  <span className="flex items-center gap-2">
                    <MonitorSmartphone className="h-4 w-4" /> {d.systemName}
                    {!d.online && <span className="text-muted-foreground">(offline)</span>}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-2">
            {target === ALL_TARGET
              ? "These values will be written to every enrolled device. Newly enrolled devices start from the built-in defaults."
              : `Overrides the configuration for ${targetDevice?.systemName ?? "this device"} only.`}
          </p>
        </CardContent>
      </Card>

      {/* Monitoring toggle */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" /> Monitoring
          </CardTitle>
          <CardDescription>
            Master switch for all data collection on the selected target.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-md border border-border p-4">
            <div>
              <p className="font-medium text-sm">Monitoring enabled</p>
              <p className="text-xs text-muted-foreground">
                When off, the agent stops logging activity and capturing screenshots.
              </p>
            </div>
            <Switch
              checked={form.monitoringEnabled}
              onCheckedChange={(checked) => setForm((f) => ({ ...f, monitoringEnabled: checked }))}
            />
          </div>
        </CardContent>
      </Card>

      {/* Screenshot capture */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Camera className="h-4 w-4 text-primary" /> Screenshot Capture
          </CardTitle>
          <CardDescription>
            Screenshots are taken at a random interval in this range. A visible
            notice is always shown before each capture.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="ssMin">Minimum interval (minutes)</Label>
              <Input
                id="ssMin"
                type="number"
                min={1}
                max={1440}
                value={form.screenshotMinMinutes}
                onChange={setNum("screenshotMinMinutes")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ssMax">Maximum interval (minutes)</Label>
              <Input
                id="ssMax"
                type="number"
                min={1}
                max={1440}
                value={form.screenshotMaxMinutes}
                onChange={setNum("screenshotMaxMinutes")}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            A screenshot is captured every {form.screenshotMinMinutes}–
            {form.screenshotMaxMinutes} minutes.
          </p>
        </CardContent>
      </Card>

      {/* Activity detection */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary" /> Activity Detection
          </CardTitle>
          <CardDescription>Idle detection and how often the agent syncs.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="idle">Idle threshold (seconds)</Label>
            <Input
              id="idle"
              type="number"
              min={10}
              max={7200}
              value={form.idleThresholdSeconds}
              onChange={setNum("idleThresholdSeconds")}
            />
            <p className="text-xs text-muted-foreground">
              Mark the user as idle after {form.idleThresholdSeconds} seconds of no input.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sync">Sync interval (seconds)</Label>
            <Input
              id="sync"
              type="number"
              min={10}
              max={3600}
              value={form.syncIntervalSeconds}
              onChange={setNum("syncIntervalSeconds")}
            />
            <p className="text-xs text-muted-foreground">
              The agent sends data and checks for commands every {form.syncIntervalSeconds} seconds.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end pt-2 pb-10">
        <Button onClick={handleSave} disabled={isSaving} className="gap-2">
          <Save className="h-4 w-4" />
          {isSaving
            ? "Saving..."
            : target === ALL_TARGET
              ? "Apply to all devices"
              : "Save changes"}
        </Button>
      </div>
    </div>
  );
}
