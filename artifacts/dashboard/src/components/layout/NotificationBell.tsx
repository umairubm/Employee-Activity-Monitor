import { useState } from "react";
import { useLocation } from "wouter";
import { Bell, WifiOff, Cpu, Loader2 } from "lucide-react";
import {
  useGetDeviceNotifications,
  getGetDeviceNotificationsQueryKey,
} from "@workspace/api-client-react";
import type { DeviceNotificationItem } from "@workspace/api-client-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";

function relativeTime(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function NotificationRow({
  n,
  onNavigate,
}: {
  n: DeviceNotificationItem;
  onNavigate: (deviceId: string) => void;
}) {
  const critical = n.severity === "critical";
  const Icon = n.type === "offline" ? WifiOff : Cpu;
  return (
    <button
      onClick={() => onNavigate(n.deviceId)}
      className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary"
      data-testid={`notification-${n.id}`}
    >
      <span
        className={`mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ${
          critical
            ? "bg-destructive/10 text-destructive"
            : "bg-amber-500/10 text-amber-600"
        }`}
      >
        <Icon size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{n.label}</span>
        <span className="block text-xs text-muted-foreground">{n.message}</span>
        <span className="mt-0.5 block text-[11px] text-muted-foreground/70">
          {relativeTime(n.occurredAt)}
        </span>
      </span>
    </button>
  );
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [, setLocation] = useLocation();
  const { data, isLoading } = useGetDeviceNotifications({
    query: {
      queryKey: getGetDeviceNotificationsQueryKey(),
      refetchInterval: 30_000,
    },
  });
  const notifications = data ?? [];
  const count = notifications.length;

  const handleNavigate = (deviceId: string) => {
    setOpen(false);
    setLocation(`/devices/${deviceId}`);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="relative flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          title="Notifications"
          data-testid="button-notifications"
        >
          <Bell size={18} />
          {count > 0 && (
            <span
              className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground"
              data-testid="badge-notification-count"
            >
              {count > 99 ? "99+" : count}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(22rem,calc(100vw-2rem))] p-0"
      >
        <div className="border-b border-border px-4 py-2.5 text-sm font-semibold">
          Notifications
        </div>
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin" />
            Loading…
          </div>
        ) : count === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            All devices are online and up to date.
          </div>
        ) : (
          <ScrollArea className="max-h-[min(24rem,60vh)]">
            <div className="divide-y divide-border">
              {notifications.map((n) => (
                <NotificationRow key={n.id} n={n} onNavigate={handleNavigate} />
              ))}
            </div>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
}
