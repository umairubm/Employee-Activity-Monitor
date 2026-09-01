import { useEffect, useState } from "react";
import {
  getGetDeviceNotificationsQueryKey,
  getGetDeviceQueryKey,
  getListDevicesQueryKey,
  getListUsersQueryKey,
  useListUsers,
  useSetDeviceAssignment,
} from "@workspace/api-client-react";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

type AssignDeviceDialogProps = {
  deviceId: string;
  deviceLabel: string;
  currentUserId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const UNASSIGNED = "__unassigned__";

export function AssignDeviceDialog({
  deviceId,
  deviceLabel,
  currentUserId,
  open,
  onOpenChange,
}: AssignDeviceDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: users, isLoading: usersLoading } = useListUsers({
    query: {
      queryKey: getListUsersQueryKey(),
      enabled: open,
    },
  });
  const assignDevice = useSetDeviceAssignment();
  const [selectedUserId, setSelectedUserId] = useState(
    currentUserId ?? UNASSIGNED,
  );

  useEffect(() => {
    if (open) setSelectedUserId(currentUserId ?? UNASSIGNED);
  }, [currentUserId, open]);

  const handleSave = () => {
    assignDevice.mutate(
      {
        id: deviceId,
        data: {
          assignedUserId:
            selectedUserId === UNASSIGNED ? null : selectedUserId,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListDevicesQueryKey() });
          queryClient.invalidateQueries({
            queryKey: getGetDeviceQueryKey(deviceId),
          });
          queryClient.invalidateQueries({
            queryKey: getGetDeviceNotificationsQueryKey(),
          });
          onOpenChange(false);
          toast({
            title: "Device assignment updated",
            description: `${deviceLabel} is now assigned to ${
              selectedUserId === UNASSIGNED
                ? "no user"
                : users?.find((u) => u.id === selectedUserId)?.username ??
                  "the selected user"
            }.`,
          });
        },
        onError: (error: any) => {
          toast({
            title: "Failed to assign device",
            description: error.message,
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!assignDevice.isPending) onOpenChange(nextOpen);
    }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Merge {deviceLabel} with an existing user</DialogTitle>
          <DialogDescription>
            Keep this laptop and its history, then add it to the selected
            user&apos;s devices. The user&apos;s other laptops will not be changed.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 py-3">
          <Label htmlFor={`assign-device-${deviceId}`}>Existing user</Label>
          <Select
            value={selectedUserId}
            onValueChange={setSelectedUserId}
            disabled={usersLoading || assignDevice.isPending}
          >
            <SelectTrigger id={`assign-device-${deviceId}`}>
              <SelectValue
                placeholder={usersLoading ? "Loading users…" : "Select a user"}
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNASSIGNED}>No user</SelectItem>
              {(users ?? []).map((user) => (
                <SelectItem key={user.id} value={user.id}>
                  {user.username} ({user.email})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {users?.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No existing users are available in this company.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={assignDevice.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={
              usersLoading ||
              assignDevice.isPending ||
              selectedUserId === (currentUserId ?? UNASSIGNED)
            }
          >
            {assignDevice.isPending ? "Saving…" : "Save assignment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}