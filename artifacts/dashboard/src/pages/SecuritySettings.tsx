import React, { useEffect, useState } from "react";
import {
  useGetSecuritySettings,
  getGetSecuritySettingsQueryKey,
  useUpdateSecuritySettings,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Lock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function SecuritySettings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: settings, isLoading } = useGetSecuritySettings();
  const update = useUpdateSecuritySettings();

  const [passwordMinLength, setPasswordMinLength] = useState(8);
  const [requireUppercase, setRequireUppercase] = useState(false);
  const [requireNumber, setRequireNumber] = useState(false);
  const [requireSymbol, setRequireSymbol] = useState(false);
  const [sessionTimeoutMinutes, setSessionTimeoutMinutes] = useState(10080);
  const [allowedIpRanges, setAllowedIpRanges] = useState("");
  const [mfaRequired, setMfaRequired] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setPasswordMinLength(settings.passwordMinLength);
    setRequireUppercase(settings.passwordRequireUppercase);
    setRequireNumber(settings.passwordRequireNumber);
    setRequireSymbol(settings.passwordRequireSymbol);
    setSessionTimeoutMinutes(settings.sessionTimeoutMinutes);
    setAllowedIpRanges((settings.allowedIpRanges ?? []).join("\n"));
    setMfaRequired(settings.mfaRequired);
  }, [settings]);

  const handleSave = () => {
    const ranges = allowedIpRanges
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    update.mutate(
      {
        data: {
          passwordMinLength,
          passwordRequireUppercase: requireUppercase,
          passwordRequireNumber: requireNumber,
          passwordRequireSymbol: requireSymbol,
          sessionTimeoutMinutes,
          allowedIpRanges: ranges,
          mfaRequired,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetSecuritySettingsQueryKey() });
          toast({ title: "Security policy saved" });
        },
        onError: () => toast({ title: "Could not save settings", variant: "destructive" }),
      },
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <Lock className="h-7 w-7" /> Security Policy
        </h1>
        <p className="text-muted-foreground mt-1">Password rules, session lifetime, and access restrictions for your company.</p>
      </div>

      {isLoading ? (
        <div className="space-y-4 animate-pulse">
          {[1, 2, 3].map((i) => <div key={i} className="h-40 bg-muted rounded-lg" />)}
        </div>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Password policy</CardTitle>
              <CardDescription>Requirements enforced when staff set or change passwords.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-2 max-w-xs">
                <Label htmlFor="minlen">Minimum length</Label>
                <Input id="minlen" type="number" min={6} max={128} value={passwordMinLength} onChange={(e) => setPasswordMinLength(parseInt(e.target.value) || 6)} />
              </div>
              <ToggleRow label="Require an uppercase letter" checked={requireUppercase} onChange={setRequireUppercase} />
              <ToggleRow label="Require a number" checked={requireNumber} onChange={setRequireNumber} />
              <ToggleRow label="Require a symbol" checked={requireSymbol} onChange={setRequireSymbol} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Sessions & access</CardTitle>
              <CardDescription>Control session lifetime and where staff can sign in from.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-2 max-w-xs">
                <Label htmlFor="timeout">Session timeout (minutes)</Label>
                <Input id="timeout" type="number" min={5} max={43200} value={sessionTimeoutMinutes} onChange={(e) => setSessionTimeoutMinutes(parseInt(e.target.value) || 5)} />
                <p className="text-xs text-muted-foreground">Default 10080 (7 days).</p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ips">Allowed IP ranges</Label>
                <Textarea id="ips" rows={4} placeholder={"203.0.113.0/24\n198.51.100.42/32"} value={allowedIpRanges} onChange={(e) => setAllowedIpRanges(e.target.value)} />
                <p className="text-xs text-muted-foreground">One CIDR per line (or comma-separated). Leave empty for no restriction.</p>
              </div>
              <ToggleRow label="Require multi-factor authentication" checked={mfaRequired} onChange={setMfaRequired} />
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={update.isPending}>
              {update.isPending ? "Saving..." : "Save changes"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border p-3">
      <Label className="cursor-pointer">{label}</Label>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
