import {
  useGetDropboxSystemStatus,
  getGetDropboxSystemStatusQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  HardDrive,
  CheckCircle2,
  XCircle,
  RefreshCw,
  CloudUpload,
  AlertTriangle,
} from "lucide-react";

const AUTH_MODE_LABEL: Record<string, string> = {
  refresh_token: "Refresh token (durable, auto-renewing)",
  access_token: "Static access token (short-lived)",
  connector: "Replit Dropbox connector",
  none: "Not configured",
};

function CredBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center justify-between rounded-md border px-3 py-2">
      <span className="text-sm">{label}</span>
      {ok ? (
        <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
          Configured
        </Badge>
      ) : (
        <Badge variant="outline" className="text-muted-foreground">
          Missing
        </Badge>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "default" | "warn" | "bad" | "good";
}) {
  const toneClass =
    tone === "bad"
      ? "text-destructive"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : tone === "good"
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-foreground";
  return (
    <Card>
      <CardContent className="pt-6">
        <div className={`text-3xl font-bold tabular-nums ${toneClass}`}>
          {value.toLocaleString()}
        </div>
        <div className="text-sm text-muted-foreground mt-1">{label}</div>
      </CardContent>
    </Card>
  );
}

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export default function Storage() {
  const queryClient = useQueryClient();
  const { data, isLoading, isFetching } = useGetDropboxSystemStatus();

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: getGetDropboxSystemStatusQueryKey(),
    });

  const auth = data?.auth;
  const health = data?.health;
  const stats = data?.screenshots;
  const errors = data?.recentErrors ?? [];

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Storage</h1>
          <p className="text-muted-foreground mt-1">
            Dropbox connection status and screenshot upload health. Credential
            values are never shown here — only whether each is configured.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refresh}
          disabled={isFetching}
        >
          <RefreshCw
            className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {/* Connection health */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <HardDrive className="h-5 w-5" />
            Dropbox connection
          </CardTitle>
          <CardDescription>
            {isLoading
              ? "Checking connection…"
              : auth
                ? `Active auth mode: ${AUTH_MODE_LABEL[auth.mode] ?? auth.mode}`
                : "Unavailable"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            {health?.ok ? (
              <>
                <CheckCircle2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
                <div>
                  <div className="font-medium">Connected</div>
                  <div className="text-sm text-muted-foreground">
                    Dropbox responded to a live authentication check.
                  </div>
                </div>
              </>
            ) : (
              <>
                <XCircle className="h-6 w-6 text-destructive" />
                <div>
                  <div className="font-medium">
                    {isLoading ? "Checking…" : "Not connected"}
                  </div>
                  {health?.error && (
                    <div className="text-sm text-destructive break-all">
                      {health.error}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
          {health?.checkedAt && (
            <p className="text-xs text-muted-foreground">
              Last checked {fmtDate(health.checkedAt)}
            </p>
          )}

          {auth && (
            <div className="grid gap-2 sm:grid-cols-2">
              <CredBadge
                ok={auth.refreshTokenConfigured}
                label="Refresh token"
              />
              <CredBadge ok={auth.appKeyConfigured} label="App key" />
              <CredBadge ok={auth.appSecretConfigured} label="App secret" />
              <CredBadge
                ok={auth.accessTokenConfigured}
                label="Static access token"
              />
              <CredBadge
                ok={auth.connectorAvailable}
                label="Replit connector"
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Upload stats */}
      <div>
        <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
          <CloudUpload className="h-5 w-5" />
          Screenshot uploads
        </h2>
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          <StatCard label="Total" value={stats?.total ?? 0} />
          <StatCard
            label="Pending"
            value={stats?.pending ?? 0}
            tone={stats && stats.pending > 0 ? "warn" : "default"}
          />
          <StatCard
            label="Uploaded"
            value={stats?.uploaded ?? 0}
            tone="good"
          />
          <StatCard
            label="Failed"
            value={stats?.failed ?? 0}
            tone={stats && stats.failed > 0 ? "bad" : "default"}
          />
        </div>
      </div>

      {/* Error log */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <AlertTriangle className="h-5 w-5" />
            Recent upload errors
          </CardTitle>
          <CardDescription>
            The most recent screenshots that failed to upload to Dropbox, across
            all companies.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : errors.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              No upload failures. Everything is syncing cleanly.
            </div>
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Device</TableHead>
                    <TableHead>Captured</TableHead>
                    <TableHead className="text-right">Attempts</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead>Last error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {errors.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="font-medium whitespace-nowrap">
                        {e.deviceName ?? (
                          <span className="text-muted-foreground">
                            {e.deviceId.slice(0, 8)}…
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {fmtDate(e.capturedAt)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {e.attempts}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {fmtBytes(e.fileSizeBytes)}
                      </TableCell>
                      <TableCell className="max-w-md">
                        <span className="text-destructive break-words">
                          {e.lastError ?? "—"}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
