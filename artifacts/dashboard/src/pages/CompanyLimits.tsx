import { useEffect, useState } from "react";
import {
  useListCompanies,
  getListCompaniesQueryKey,
  useUpdateCompanyLimits,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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

  const [selectedId, setSelectedId] = useState<string>("");
  const [maxManagers, setMaxManagers] = useState<string>("");
  const [maxDevices, setMaxDevices] = useState<string>("");

  const selected = companies?.find((c) => c.id === selectedId);

  // When the selected company changes, load its current limits into the form.
  useEffect(() => {
    if (!selected) return;
    setMaxManagers(selected.maxManagers == null ? "" : String(selected.maxManagers));
    setMaxDevices(selected.maxDevices == null ? "" : String(selected.maxDevices));
  }, [selected]);

  const parseLimit = (v: string): number | null => {
    const trimmed = v.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? Math.floor(n) : null;
  };

  const handleSave = () => {
    if (!selectedId) return;
    updateLimits.mutate(
      {
        id: selectedId,
        data: {
          maxManagers: parseLimit(maxManagers),
          maxDevices: parseLimit(maxDevices),
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
    (maxManagers.trim() !== "" && Number(maxManagers) < 0) ||
    (maxDevices.trim() !== "" && Number(maxDevices) < 0);

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
                  <Input
                    id="maxManagers"
                    type="number"
                    min={0}
                    placeholder="Unlimited"
                    value={maxManagers}
                    onChange={(e) => setMaxManagers(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="maxDevices">Max Devices</Label>
                    <span className="text-sm text-muted-foreground">
                      {usageLabel(selected?.deviceCount, selected?.maxDevices, "device")}
                    </span>
                  </div>
                  <Input
                    id="maxDevices"
                    type="number"
                    min={0}
                    placeholder="Unlimited"
                    value={maxDevices}
                    onChange={(e) => setMaxDevices(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <InfinityIcon className="h-4 w-4" />
                A blank field means no limit for that resource.
              </div>

              <div className="flex justify-end">
                <Button onClick={handleSave} disabled={invalid || updateLimits.isPending}>
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
