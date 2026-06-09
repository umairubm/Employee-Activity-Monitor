import {
  useListDownloads,
  getListDownloadsQueryKey,
} from "@workspace/api-client-react";
import type { DownloadItem } from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Download,
  Apple,
  Monitor,
  ShieldCheck,
  RefreshCw,
  PackageOpen,
} from "lucide-react";

function formatSize(bytes: number | null | undefined): string {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const PLATFORM_ICON: Record<string, typeof Monitor> = {
  windows: Monitor,
  macos: Apple,
};

function InstallerCard({ item }: { item: DownloadItem }) {
  const Icon = PLATFORM_ICON[item.platform] ?? Monitor;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Icon className="h-5 w-5 text-primary" /> {item.label}
        </CardTitle>
        <CardDescription>
          {item.platform === "windows"
            ? "Signed-in users can install without admin rights (.exe installer)."
            : "Drag-and-drop install from a disk image (.dmg)."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {item.available ? (
          <>
            <div className="text-xs text-muted-foreground space-y-1">
              <div className="flex justify-between">
                <span>File</span>
                <span className="font-mono text-foreground truncate max-w-[60%] text-right">
                  {item.fileName}
                </span>
              </div>
              {item.version && (
                <div className="flex justify-between">
                  <span>Version</span>
                  <span className="text-foreground">{item.version}</span>
                </div>
              )}
              {item.sizeBytes != null && (
                <div className="flex justify-between">
                  <span>Size</span>
                  <span className="text-foreground">{formatSize(item.sizeBytes)}</span>
                </div>
              )}
            </div>
            <Button asChild className="w-full gap-2">
              <a href={item.downloadUrl ?? "#"} download>
                <Download className="h-4 w-4" />
                Download for {item.label}
              </a>
            </Button>
          </>
        ) : (
          <div className="rounded-md border border-dashed border-border p-4 text-center">
            <PackageOpen className="h-6 w-6 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm font-medium">Not published yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              The {item.label} installer ({item.extension}) appears here once a
              build is published from GitHub Actions.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Downloads() {
  const { data, isLoading, isError, refetch, isFetching } = useListDownloads({
    query: { queryKey: getListDownloadsQueryKey() },
  });

  const items = data?.items ?? [];
  const anyAvailable = items.some((i) => i.available);

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-3xl">
      <div>
        <div className="flex items-center gap-3 mb-2">
          <Download className="h-6 w-6 text-primary" />
          <h1 className="text-3xl font-bold tracking-tight">Download the Agent</h1>
        </div>
        <p className="text-muted-foreground">
          Install the desktop agent on each enrolled device. Distribute these
          installers along with an enrollment token from the Enrollment Tokens page.
        </p>
      </div>

      <Card className="bg-secondary/40">
        <CardContent className="flex items-start gap-3 pt-6">
          <ShieldCheck className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
          <p className="text-sm text-muted-foreground">
            On first launch the agent shows a consent dialog and an always-visible
            tray icon. Monitoring only begins after the user consents, and a notice
            is shown before every screenshot. There is no hidden mode.
          </p>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Installers
        </h2>
        <Button
          variant="ghost"
          size="sm"
          className="gap-2"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading installers…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">
          Could not check for installers. Try refreshing.
        </p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {items.map((item) => (
              <InstallerCard key={item.platform} item={item} />
            ))}
          </div>
          {!anyAvailable && (
            <p className="text-xs text-muted-foreground pt-2">
              No installers have been published yet. Builds are produced by the
              "Build Agent Installers" GitHub Actions workflow — push a tag like{" "}
              <code className="font-mono">agent-v0.1.0</code> or run it manually,
              then refresh this page.
            </p>
          )}
        </>
      )}
    </div>
  );
}
