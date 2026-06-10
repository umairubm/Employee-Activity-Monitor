import React from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { 
  LayoutDashboard, 
  MonitorSmartphone, 
  Activity, 
  Image as ImageIcon, 
  CalendarCheck,
  Tags, 
  KeyRound, 
  LogOut,
  ShieldCheck,
  Settings,
  Download
} from "lucide-react";
import { useLogout, getGetCurrentUserQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

const NAV_ITEMS = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/devices", label: "Devices", icon: MonitorSmartphone },
  { href: "/activity", label: "Activity Logs", icon: Activity },
  { href: "/screenshots", label: "Screenshots", icon: ImageIcon },
  { href: "/attendance", label: "Attendance", icon: CalendarCheck },
  { href: "/categories", label: "App Categories", icon: Tags },
  { href: "/tokens", label: "Enrollment Tokens", icon: KeyRound },
  { href: "/settings", label: "Agent Settings", icon: Settings },
  { href: "/downloads", label: "Download Agent", icon: Download },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const logout = useLogout();

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        queryClient.setQueryData(getGetCurrentUserQueryKey(), null);
        queryClient.clear();
        setLocation("/login");
      }
    });
  };

  return (
    <div className="flex min-h-screen w-full flex-col lg:flex-row bg-background">
      {/* Sidebar */}
      <aside className="w-full lg:w-64 border-r border-border bg-card flex flex-col flex-shrink-0">
        <div className="p-6 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground">
            <ShieldCheck size={20} />
          </div>
          <span className="font-bold tracking-tight">Workforce</span>
        </div>
        
        <nav className="flex-1 px-4 flex flex-col gap-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            const Icon = item.icon;
            return (
              <Link 
                key={item.href} 
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                  isActive 
                    ? "bg-primary text-primary-foreground" 
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                }`}
              >
                <Icon size={18} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="p-4 mt-auto border-t border-border">
          <div className="flex items-center justify-between">
            <div className="flex flex-col overflow-hidden">
              <span className="text-sm font-medium truncate">{user?.username}</span>
              <span className="text-xs text-muted-foreground capitalize truncate">{user?.role?.replace('_', ' ')}</span>
            </div>
            <button 
              onClick={handleLogout}
              className="p-2 text-muted-foreground hover:text-destructive transition-colors rounded-md hover:bg-secondary"
              title="Log out"
            >
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 md:p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
