import { useEffect, useState } from "react";
import { useSearch } from "wouter";
import {
  useListCompanies,
  getListCompaniesQueryKey,
  useUpdateCompanyLimits,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SlidersHorizontal, Infinity as InfinityIcon } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

/** Render "3 / 5 managers", "3 managers (unlimited)", or "— managers". */
function usageLabel(
  used: number | undefined,
  max: number | null | undefined,
  noun: string,
): string {
  const plural = `${noun}s`;
  if (used == null) return `— ${plural}`;
  if (max == null) return `${used} ${used === 1 ? noun : plural} (unlimited)`;
  return `${used} / ${max} ${plural}`;
}

export default function CompanyLimits() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: companies, isLoading } = useListCompanies();
  const updateLimits = useUpdateCompanyLimits();

  const search = useSearch();
  const preselectId = new URLSearchParams(search).get("company") ?? "";

  const [selectedId, setSelectedId] = useState<string>("");
  const [maxManagers, setMaxManagers] = useState<string>("");
  const [maxDevices, setMaxDevices] = useState<string>("");
  const [unlimitedManagers, setUnlimitedManagers] = useState(true);
  const [unlimitedDevices, setUnlimitedDevices] = useState(true);
  const [confirmUnderUsage, setConfirmUnderUsage] = useState(false);

  // Honor a company pre-selected via ?company=<id> (e.g. from the Companies list),
  // once that company is present in the loaded list.
  useEffect(() => {
    if (!preselectId) return;
    if (companies?.some((c) => c.id === preselectId)) {
      setSelectedId(preselectId);
    }
  }, [preselectId, companies]);

  const selected = companies?.find((c) => c.id === selectedId);

  // When the selected company changes, load its current limits into the form.
  useEffect(() => {
    if (!selected) return;
    setMaxManagers(selected.maxManagers == null ? "" : String(selected.maxManagers));
    setMaxDevices(selected.maxDevices == null ? "" : String(selected.maxDevices));
    setUnlimitedManagers(selected.maxManagers == null);
    setUnlimitedDevices(selected.maxDevices == null);
    setConfirmUnderUsage(false);
  }, [selected]);

  const parseLimit = (v: string): number | null => {
    const trimmed = v.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? Math.floor(n) : null;
  };

  const handleSave = () => {
    if (!selectedId) return;
    if (underUsage && !confirmUnderUsage) return;
    updateLimits.mutate(
      {
        id: selectedId,
        data: {
          maxManagers: unlimitedManagers ? null : parseLimit(maxManagers),
          maxDevices: unlimitedDevices ? null : parseLimit(maxDevices),
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCompaniesQueryKey() });
          toast({ title: "Limits saved" });
        },
        onError: () => toast({ title: "Could not save limits", variant: "destructive" }),
      },
    );
  };

  const invalid =
    (!unlimitedManagers &&
      (maxManagers.trim() === "" || Number(maxManagers) < 0)) ||
    (!unlimitedDevices && (maxDevices.trim() === "" || Number(maxDevices) < 0));

  const parsedManagers = unlimitedManagers ? null : parseLimit(maxManagers);
  const parsedDevices = unlimitedDevices ? null : parseLimit(maxDevices);

  const managerCount = selected?.managerCount;
  const deviceCount = selected?.deviceCount;

  const managersBelow =
    parsedManagers != null && managerCount != null && parsedManagers < managerCount;
  const devicesBelow =
    parsedDevices != null && deviceCount != null && parsedDevices < deviceCount;
  const underUsage = managersBelow || devicesBelow;

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Company Limits</h1>
        <p className="text-muted-foreground mt-1">
          Restrict how many managers and devices each company is allowed. Leave a
          field blank for unlimited.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <SlidersHorizontal className="h-5 w-5" />
            Configure quotas
          </CardTitle>
          <CardDescription>Select a company, then set its limits.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-2">
            <Label>Company</Label>
            <Select value={selectedId} onValueChange={setSelectedId} disabled={isLoading}>
              <SelectTrigger>
                <SelectValue placeholder={isLoading ? "Loading…" : "Select a company"} />
              </SelectTrigger>
              <SelectContent>
                {companies?.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedId && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="maxManagers">Max Managers</Label>
                    <span className="text-sm text-muted-foreground">
                      {usageLabel(selected?.managerCount, selected?.maxManagers, "manager")}
                    </span>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={unlimitedManagers}
                      onCheckedChange={(v) => {
                        setUnlimitedManagers(v === true);
                        setConfirmUnderUsage(false);
                      }}
                    />
                    Unlimited
                  </label>
                  {!unlimitedManagers && (
                    <Input
                      id="maxManagers"
                      type="number"
                      min={0}
                      placeholder="e.g. 5"
                      value={maxManagers}
                      onChange={(e) => {
                        setMaxManagers(e.target.value);
                        setConfirmUnderUsage(false);
                      }}
                    />
                  )}
                </div>
                <div className="grid gap-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="maxDevices">Max Devices</Label>
                    <span className="text-sm text-muted-foreground">
                      {usageLabel(selected?.deviceCount, selected?.maxDevices, "device")}
                    </span>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={unlimitedDevices}
                      onCheckedChange={(v) => {
                        setUnlimitedDevices(v === true);
                        setConfirmUnderUsage(false);
                      }}
                    />
                    Unlimited
                  </label>
                  {!unlimitedDevices && (
                    <Input
                      id="maxDevices"
                      type="number"
                      min={0}
                      placeholder="e.g. 25"
                      value={maxDevices}
                      onChange={(e) => {
                        setMaxDevices(e.target.value);
                        setConfirmUnderUsage(false);
                      }}
                    />
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <InfinityIcon className="h-4 w-4" />
                Check “Unlimited” to remove the limit for that resource.
              </div>

              {underUsage && (
                <Alert variant="destructive">
                  <AlertTitle>Limit is below current usage</AlertTitle>
                  <AlertDescription className="space-y-2">
                    <div>
                      {managersBelow && (
                        <p>
                          Max Managers ({parsedManagers}) is below the {managerCount}{" "}
                          {managerCount === 1 ? "manager" : "managers"} already in use.
                        </p>
                      )}
                      {devicesBelow && (
                        <p>
                          Max Devices ({parsedDevices}) is below the {deviceCount}{" "}
                          {deviceCount === 1 ? "device" : "devices"} already enrolled.
                        </p>
                      )}
                      <p>
                        Saving will leave this company over its limit. Existing managers
                        and devices are not removed, but no new ones can be added until
                        usage drops below the limit.
                      </p>
                    </div>
                    <label className="flex items-center gap-2 font-medium">
                      <Checkbox
                        checked={confirmUnderUsage}
                        onCheckedChange={(v) => setConfirmUnderUsage(v === true)}
                      />
                      I understand and want to save this limit anyway.
                    </label>
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex justify-end">
                <Button
                  onClick={handleSave}
                  disabled={
                    invalid ||
                    updateLimits.isPending ||
                    (underUsage && !confirmUnderUsage)
                  }
                >
                  {updateLimits.isPending ? "Saving…" : "Save Limits"}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
