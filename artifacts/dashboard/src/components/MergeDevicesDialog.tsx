import { useEffect, useMemo, useState } from "react";
import {
  getGetDeviceNotificationsQueryKey,
  getGetDeviceQueryKey,
  getListDevicesQueryKey,
  useListDevices,
  useMergeDevices,
} from "@workspace/api-client-react";
import type { DeviceItem } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { useToast } from "@/hooks/use-toast";

type MergeDevicesDialogProps = {
  replacementDeviceId: string;
  replacementDeviceLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const MERGE_CONFIRMATION = "MERGE DEVICES";

function predecessorDescription(device: DeviceItem) {
  const person = device.assignedUsername || device.tokenLabel || "No user label";
  const lastSeen = device.lastSeenAt
    ? new Date(device.lastSeenAt).toLocaleDateString()
    : "never";
  return `${person} · ${device.osType} · last seen ${lastSeen}`;
}

export function MergeDevicesDialog({
  replacementDeviceId,
  replacementDeviceLabel,
  open,
  onOpenChange,
}: MergeDevicesDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: devices, isLoading: devicesLoading } = useListDevices({
    query: {
      queryKey: getListDevicesQueryKey(),
      enabled: open,
    },
  });
  const mergeDevices = useMergeDevices();
  const [predecessorDeviceId, setPredecessorDeviceId] = useState("");
  const [confirmation, setConfirmation] = useState("");

  const predecessorDevices = useMemo(
    () =>
      (devices ?? []).filter(
        (device) =>
          device.id !== replacementDeviceId && !device.mergedIntoDeviceId,
      ),
    [devices, replacementDeviceId],
  );

  useEffect(() => {
    if (open) {
      setPredecessorDeviceId("");
      setConfirmation("");
    }
  }, [open, replacementDeviceId]);

  const predecessor = predecessorDevices.find(
    (device) => device.id === predecessorDeviceId,
  );

  const handleSave = () => {
    if (!predecessor || confirmation !== MERGE_CONFIRMATION) return;

    mergeDevices.mutate(
      {
        id: replacementDeviceId,
        data: {
          sourceDeviceId: predecessor.id,
          confirmation: MERGE_CONFIRMATION,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListDevicesQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: getGetDeviceQueryKey(replacementDeviceId),
          });
          queryClient.invalidateQueries({
            queryKey: getGetDeviceQueryKey(predecessor.id),
          });
          queryClient.invalidateQueries({
            queryKey: getGetDeviceNotificationsQueryKey(),
          });
          onOpenChange(false);
          toast({
            title: "Devices merged",
            description: `${predecessor.systemName}'s history is now part of ${replacementDeviceLabel}. The old device was retired.`,
          });
        },
        onError: (error: any) => {
          toast({
            title: "Failed to merge devices",
            description: error.message,
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!mergeDevices.isPending) onOpenChange(nextOpen);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Merge a replacement device</DialogTitle>
          <DialogDescription>
            Use this when the same person changed laptops. Keep{" "}
            <strong>{replacementDeviceLabel}</strong> as the current device and
            move the predecessor&apos;s activity, screenshots, commands, and
            alerts into it. This does not merge or delete users.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-3">
          <div className="grid gap-2">
            <Label htmlFor={`merge-predecessor-${replacementDeviceId}`}>
              Previous laptop
            </Label>
            <Select
              value={predecessorDeviceId}
              onValueChange={setPredecessorDeviceId}
              disabled={devicesLoading || mergeDevices.isPending}
            >
              <SelectTrigger id={`merge-predecessor-${replacementDeviceId}`}>
                <SelectValue
                  placeholder={
                    devicesLoading
                      ? "Loading devices…"
                      : "Select the laptop being replaced"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {predecessorDevices.map((device) => (
                  <SelectItem key={device.id} value={device.id}>
                    <span className="font-medium">{device.systemName}</span>
                    <span className="ml-2 text-muted-foreground">
                      ({device.hardwareHash.slice(0, 12)}…)
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {predecessorDescription(device)}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!devicesLoading && predecessorDevices.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No other active devices are available to merge.
              </p>
            )}
          </div>

          {predecessor && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
              <p className="font-medium">
                {predecessor.systemName} will be retired
              </p>
              <p className="mt-1 text-muted-foreground">
                Its history will remain available through{" "}
                {replacementDeviceLabel}. The replacement laptop keeps its
                current identity and settings.
              </p>
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor={`merge-confirmation-${replacementDeviceId}`}>
              Type <span className="font-mono">{MERGE_CONFIRMATION}</span> to
              confirm
            </Label>
            <Input
              id={`merge-confirmation-${replacementDeviceId}`}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder={MERGE_CONFIRMATION}
              autoComplete="off"
              disabled={mergeDevices.isPending}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mergeDevices.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={
              devicesLoading ||
              mergeDevices.isPending ||
              !predecessor ||
              confirmation !== MERGE_CONFIRMATION
            }
          >
            {mergeDevices.isPending ? "Merging…" : "Merge devices"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}