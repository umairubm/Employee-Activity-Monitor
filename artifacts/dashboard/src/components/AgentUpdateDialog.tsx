import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  getGetDeviceQueryKey,
  getListDevicesQueryKey,
  type DeviceItem,
  type PushAgentUpdateRequest,
  useListDevices,
  usePushAgentUpdate,
  useRequestAgentReleaseUploadUrl,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  CircleAlert,
  CloudUpload,
  FileArchive,
  Laptop,
  Loader2,
  ShieldCheck,
  Upload,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

type TargetMode = "all" | "device";
type SourceMode = "url" | "file";
type ReleaseKind = "installer" | "patch";
type SubmitState = "idle" | "submitting" | "success" | "error";

interface AgentUpdateDialogProps {
  /** Optional list supplied by the Devices page. The dialog also reads the cached fleet when opened elsewhere. */
  devices?: DeviceItem[];
  selectedDevice?: DeviceItem | null;
  defaultTargetMode?: TargetMode;
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const MAX_FILE_SIZE = 500 * 1024 * 1024;

function displayOs(osType?: string) {
  if (osType === "macos") return "macOS";
  if (!osType) return "Unknown OS";
  return osType.charAt(0).toUpperCase() + osType.slice(1);
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "The update could not be prepared. Review the release details and try again.";
}

function fileNameFromUrl(value: string, version: string) {
  try {
    const name = decodeURIComponent(new URL(value).pathname.split("/").pop() ?? "");
    return name || `agent-${version}.installer`;
  } catch {
    return `agent-${version}.installer`;
  }
}

function isValidArtifactFile(file: File, kind: ReleaseKind) {
  const name = file.name.toLowerCase();
  return kind === "patch" ? name.endsWith(".zip") : name.endsWith(".exe");
}

export function AgentUpdateDialog({
  devices,
  selectedDevice = null,
  defaultTargetMode = "all",
}: AgentUpdateDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState("");
  const [kind, setKind] = useState<ReleaseKind>("installer");
  const [sourceMode, setSourceMode] = useState<SourceMode>("url");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [targetMode, setTargetMode] = useState<TargetMode>(defaultTargetMode);
  const [targetDeviceId, setTargetDeviceId] = useState(selectedDevice?.id ?? "");
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [submitError, setSubmitError] = useState("");
  const [result, setResult] = useState<{
    version: string;
    targetCount: number;
    onlineCount: number;
    offlineCount: number;
  } | null>(null);

  const { data: queriedDevices } = useListDevices({
    query: { queryKey: getListDevicesQueryKey(), enabled: open },
  });
  const uploadUrlMutation = useRequestAgentReleaseUploadUrl();
  const pushMutation = usePushAgentUpdate();

  const fleet = devices ?? queriedDevices ?? [];
  const deviceOptions = useMemo(() => {
    const byId = new Map<string, DeviceItem>();
    fleet.forEach((device) => byId.set(device.id, device));
    if (selectedDevice) byId.set(selectedDevice.id, selectedDevice);
    return Array.from(byId.values());
  }, [fleet, selectedDevice]);

  const singleDevice =
    deviceOptions.find((device) => device.id === targetDeviceId) ??
    (selectedDevice?.id === targetDeviceId ? selectedDevice : null);
  const targetDevices = targetMode === "all" ? fleet : singleDevice ? [singleDevice] : [];
  const onlineCount = targetDevices.filter((device) => device.online).length;
  const offlineCount = targetDevices.length - onlineCount;
  const versionError =
    version.length > 0 && !VERSION_PATTERN.test(version.trim())
      ? "Use a version such as 4.8.1 or 4.8.1-beta.2."
      : "";
  const urlExtOk =
    kind === "patch"
      ? /\.zip$/i.test(downloadUrl.trim())
      : /\.exe$/i.test(downloadUrl.trim());
  const urlError =
    sourceMode === "url" && downloadUrl.length > 0
      ? !/^https:\/\//i.test(downloadUrl.trim())
        ? "The download URL must use HTTPS."
        : !urlExtOk
          ? kind === "patch"
            ? "The URL must point to a .zip patch bundle."
            : "The URL must point to a Windows .exe installer."
          : ""
      : "";
  const fileError =
    sourceMode === "file" && file && !isValidArtifactFile(file, kind)
      ? kind === "patch"
        ? "Choose a .zip patch bundle."
        : "Choose a Windows .exe installer."
      : "";
  const formInvalid =
    !VERSION_PATTERN.test(version.trim()) ||
    (sourceMode === "url"
      ? !/^https:\/\//i.test(downloadUrl.trim()) || !urlExtOk
      : !file || Boolean(fileError) || file.size > MAX_FILE_SIZE) ||
    (targetMode === "device" && !singleDevice);

  useEffect(() => {
    if (!open) return;
    setVersion("");
    setKind("installer");
    setSourceMode("url");
    setDownloadUrl("");
    setFile(null);
    setTargetMode(defaultTargetMode);
    setTargetDeviceId(selectedDevice?.id ?? "");
    setSubmitState("idle");
    setSubmitError("");
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [defaultTargetMode, open, selectedDevice?.id]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0] ?? null;
    setFile(nextFile);
    setSubmitState("idle");
    setSubmitError("");
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (formInvalid || submitState === "submitting") return;

    setSubmitState("submitting");
    setSubmitError("");
    setResult(null);

    try {
      const trimmedVersion = version.trim();
      let objectPath: string | null = null;
      let resolvedFileName: string;
      let resolvedDownloadUrl: string | null = null;

      if (sourceMode === "file" && file) {
        resolvedFileName = file.name;
        const upload = await uploadUrlMutation.mutateAsync({
          data: {
            name: file.name,
            size: file.size,
            contentType: file.type || "application/octet-stream",
          },
        });
        const uploadResponse = await fetch(upload.uploadURL, {
          method: "PUT",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!uploadResponse.ok) {
          throw new Error(`Installer upload failed (${uploadResponse.status}).`);
        }
        objectPath = upload.objectPath;
      } else {
        resolvedDownloadUrl = downloadUrl.trim();
        resolvedFileName = fileNameFromUrl(resolvedDownloadUrl, trimmedVersion);
      }

      const payload: PushAgentUpdateRequest = {
        version: trimmedVersion,
        kind,
        downloadUrl: resolvedDownloadUrl,
        objectPath,
        fileName: resolvedFileName,
        targetMode,
        deviceId: targetMode === "device" ? singleDevice?.id ?? null : null,
        reason: null,
      };
      const pushed = await pushMutation.mutateAsync({ data: payload });
      await queryClient.invalidateQueries({ queryKey: getListDevicesQueryKey() });
      if (selectedDevice?.id) {
        await queryClient.invalidateQueries({ queryKey: getGetDeviceQueryKey(selectedDevice.id) });
      }
      setResult({
        version: pushed.version,
        targetCount: pushed.targetCount,
        onlineCount: pushed.onlineCount,
        offlineCount: pushed.offlineCount,
      });
      setSubmitState("success");
      toast({
        title: "Agent update queued",
        description: `${pushed.targetCount} device${pushed.targetCount === 1 ? "" : "s"} targeted for version ${pushed.version}.`,
      });
    } catch (error) {
      setSubmitState("error");
      setSubmitError(errorMessage(error));
    }
  };

  const closeDialog = () => {
    if (submitState !== "submitting") setOpen(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && submitState === "submitting") return;
        setOpen(nextOpen);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <CloudUpload className="h-4 w-4" />
          Update Agent
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[min(92dvh,760px)] max-w-2xl overflow-y-auto">
        <DialogHeader className="border-b border-border pb-4 pr-8">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle>Update Agent</DialogTitle>
              <DialogDescription className="mt-1">
                Publish a signed installer and queue it for enrolled devices.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {submitState === "success" && result ? (
          <div className="space-y-5 py-2">
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
                <div>
                  <p className="font-medium text-emerald-900 dark:text-emerald-200">
                    Version {result.version} is queued
                  </p>
                  <p className="mt-1 text-sm text-emerald-800/80 dark:text-emerald-200/80">
                    Devices will download the installer on their next check-in.
                  </p>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-3 divide-x rounded-lg border bg-muted/30 py-3 text-center">
              <div>
                <p className="text-xl font-semibold">{result.targetCount}</p>
                <p className="text-xs text-muted-foreground">Targeted</p>
              </div>
              <div>
                <p className="text-xl font-semibold text-emerald-600">{result.onlineCount}</p>
                <p className="text-xs text-muted-foreground">Online now</p>
              </div>
              <div>
                <p className="text-xl font-semibold text-muted-foreground">{result.offlineCount}</p>
                <p className="text-xs text-muted-foreground">Offline</p>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={closeDialog}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-6 py-1">
            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold">Release details</h3>
                <p className="text-xs text-muted-foreground">Use the exact semantic version the agent reports.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="agent-version">Agent version</Label>
                <Input
                  id="agent-version"
                  value={version}
                  onChange={(event) => setVersion(event.target.value)}
                  placeholder="4.8.1"
                  aria-describedby="agent-version-help"
                  autoComplete="off"
                />
                <p id="agent-version-help" className={`text-xs ${versionError ? "text-destructive" : "text-muted-foreground"}`}>
                  {versionError || "Pre-release versions are supported, for example 4.8.1-beta.2."}
                </p>
              </div>
            </section>

            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold">Release type</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${kind === "installer" ? "border-primary bg-primary/5" : "border-border"}`}>
                  <input
                    type="radio"
                    name="agent-kind"
                    value="installer"
                    checked={kind === "installer"}
                    onChange={() => { setKind("installer"); setFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                    className="mt-1 accent-[hsl(var(--primary))]"
                  />
                  <span>
                    <span className="block text-sm font-medium">Full installer (.exe)</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">The agent runs it and reinstalls itself.</span>
                  </span>
                </label>
                <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${kind === "patch" ? "border-primary bg-primary/5" : "border-border"}`}>
                  <input
                    type="radio"
                    name="agent-kind"
                    value="patch"
                    checked={kind === "patch"}
                    onChange={() => { setKind("patch"); setFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                    className="mt-1 accent-[hsl(var(--primary))]"
                  />
                  <span>
                    <span className="block text-sm font-medium">Code patch (.zip)</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">The agent extracts it over its files and restarts.</span>
                  </span>
                </label>
              </div>
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold">{kind === "patch" ? "Patch source" : "Installer source"}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${sourceMode === "url" ? "border-primary bg-primary/5" : "border-border"}`}>
                  <input
                    type="radio"
                    name="agent-source"
                    value="url"
                    checked={sourceMode === "url"}
                    onChange={() => setSourceMode("url")}
                    className="mt-1 accent-[hsl(var(--primary))]"
                  />
                  <span>
                    <span className="block text-sm font-medium">HTTPS download URL</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">The device downloads from your release host.</span>
                  </span>
                </label>
                <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${sourceMode === "file" ? "border-primary bg-primary/5" : "border-border"}`}>
                  <input
                    type="radio"
                    name="agent-source"
                    value="file"
                    checked={sourceMode === "file"}
                    onChange={() => setSourceMode("file")}
                    className="mt-1 accent-[hsl(var(--primary))]"
                  />
                  <span>
                    <span className="block text-sm font-medium">Upload installer</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">Private storage, up to 500 MB.</span>
                  </span>
                </label>
              </div>

              {sourceMode === "url" ? (
                <div className="space-y-2">
                  <Label htmlFor="agent-download-url">HTTPS download URL</Label>
                  <Input
                    id="agent-download-url"
                    type="url"
                    inputMode="url"
                    value={downloadUrl}
                    onChange={(event) => setDownloadUrl(event.target.value)}
                    placeholder="https://releases.example.com/agent-4.8.1.pkg"
                    aria-describedby="agent-url-help"
                  />
                  <p id="agent-url-help" className={`text-xs ${urlError ? "text-destructive" : "text-muted-foreground"}`}>
                    {urlError || "The URL is stored with the release so devices can retrieve it."}
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="agent-installer">Installer file</Label>
                  <label htmlFor="agent-installer" className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-input bg-muted/20 px-4 py-3 hover:bg-muted/40">
                    <FileArchive className="h-5 w-5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{file?.name || (kind === "patch" ? "Choose a patch bundle" : "Choose an installer file")}</span>
                       <span className="block text-xs text-muted-foreground">{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : kind === "patch" ? ".zip patch bundle" : "Windows .exe installer"}</span>
                    </span>
                    <Upload className="h-4 w-4 text-muted-foreground" />
                    <input
                      ref={fileInputRef}
                      id="agent-installer"
                      type="file"
                       accept={kind === "patch" ? ".zip,application/zip,application/octet-stream" : ".exe,application/vnd.microsoft.portable-executable,application/octet-stream"}
                      onChange={handleFileChange}
                      className="sr-only"
                    />
                  </label>
                  {fileError && <p className="text-xs text-destructive">{fileError}</p>}
                  {file && file.size > MAX_FILE_SIZE && <p className="text-xs text-destructive">The installer must be 500 MB or smaller.</p>}
                </div>
              )}
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold">Deployment target</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${targetMode === "all" ? "border-primary bg-primary/5" : "border-border"}`}>
                  <input
                    type="radio"
                    name="agent-target"
                    value="all"
                    checked={targetMode === "all"}
                    onChange={() => setTargetMode("all")}
                    className="mt-1 accent-[hsl(var(--primary))]"
                  />
                  <Users className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span>
                    <span className="block text-sm font-medium">All Enrolled Devices</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">Queue this release for the full fleet.</span>
                  </span>
                </label>
                <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${targetMode === "device" ? "border-primary bg-primary/5" : "border-border"}`}>
                  <input
                    type="radio"
                    name="agent-target"
                    value="device"
                    checked={targetMode === "device"}
                    onChange={() => setTargetMode("device")}
                    className="mt-1 accent-[hsl(var(--primary))]"
                  />
                  <Laptop className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span>
                    <span className="block text-sm font-medium">A single device</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">Use for a controlled rollout or repair.</span>
                  </span>
                </label>
              </div>

              {targetMode === "device" && (
                <div className="space-y-3">
                  <Label htmlFor="agent-target-device">Device</Label>
                  <select
                    id="agent-target-device"
                    value={targetDeviceId}
                    onChange={(event) => setTargetDeviceId(event.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="" disabled>Select an enrolled device</option>
                    {deviceOptions.map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.systemName}{device.assignedUsername ? ` · ${device.assignedUsername}` : ""}
                      </option>
                    ))}
                  </select>
                  {singleDevice && (
                    <div className="rounded-lg border bg-muted/25 p-3">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <Laptop className="h-4 w-4 shrink-0 text-primary" />
                          <span className="truncate text-sm font-medium">{singleDevice.systemName}</span>
                        </div>
                        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${singleDevice.online ? "text-emerald-600" : "text-muted-foreground"}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${singleDevice.online ? "bg-emerald-500" : "bg-muted-foreground"}`} />
                          {singleDevice.online ? "Online" : "Offline"}
                        </span>
                      </div>
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
                        <div><dt className="text-muted-foreground">Employee</dt><dd className="mt-0.5 truncate font-medium">{singleDevice.assignedUsername || "Unassigned"}</dd></div>
                        <div><dt className="text-muted-foreground">Current agent</dt><dd className="mt-0.5 font-medium">{singleDevice.agentVersion || "Unknown"}</dd></div>
                        <div><dt className="text-muted-foreground">OS</dt><dd className="mt-0.5 font-medium">{displayOs(singleDevice.osType)}</dd></div>
                        <div><dt className="text-muted-foreground">Target</dt><dd className="mt-0.5 font-medium">1 device</dd></div>
                      </dl>
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border bg-muted/25 px-3 py-2.5 text-xs">
                <span className="font-medium">{targetDevices.length} target{targetDevices.length === 1 ? "" : "s"}</span>
                <span className="inline-flex items-center gap-1.5 text-emerald-600"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />{onlineCount} online</span>
                <span className="inline-flex items-center gap-1.5 text-muted-foreground"><span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />{offlineCount} offline</span>
              </div>
            </fieldset>

            {submitState === "error" && (
              <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{submitError}</span>
              </div>
            )}

            <DialogFooter className="gap-2 border-t border-border pt-4 sm:gap-0">
              <Button type="button" variant="outline" onClick={closeDialog} disabled={submitState === "submitting"}>Cancel</Button>
              <Button type="submit" disabled={formInvalid || submitState === "submitting"}>
                {submitState === "submitting" ? (
                  <><Loader2 className="h-4 w-4 animate-spin" />{sourceMode === "file" && uploadUrlMutation.isPending ? "Preparing upload..." : "Queueing update..."}</>
                ) : (
                  <><CloudUpload className="h-4 w-4" />Queue agent update</>
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default AgentUpdateDialog;