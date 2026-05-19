import * as React from "react";
import {
  LayoutDashboard,
  Clock,
  Camera,
  Monitor,
  Shield,
  Settings,
  Bell,
  ChevronRight,
  Menu,
  X,
  LogOut,
  AlertTriangle,
} from "lucide-react";
import { useAppStore } from "../store";

export type Page = "dashboard" | "timeline" | "screenshots" | "devices" | "settings";

interface SidebarProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
}

const navItems: { id: Page; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "timeline", label: "Timeline", icon: Clock },
  { id: "screenshots", label: "Screenshots", icon: Camera },
  { id: "devices", label: "Devices", icon: Monitor },
  { id: "settings", label: "Settings", icon: Settings },
];

export function Sidebar({ currentPage, onNavigate }: SidebarProps) {
  const { devices } = useAppStore();
  const alertCount = devices.filter((d) => d.automationDetected).length;
  const lockedCount = devices.filter((d) => d.isLocked).length;

  return (
    <aside className="fixed left-0 top-0 h-screen w-64 bg-slate-900 text-white flex flex-col z-40">
      {/* Logo */}
      <div className="p-5 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-indigo-600 rounded-lg flex items-center justify-center">
            <Shield className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="font-bold text-white text-sm leading-tight">Active Tracker</h1>
            <p className="text-slate-400 text-xs">Enterprise Monitor</p>
          </div>
        </div>
      </div>

      {/* Status Pills */}
      <div className="px-4 py-3 flex gap-2">
        {alertCount > 0 && (
          <span className="flex items-center gap-1 text-[10px] bg-amber-500/20 text-amber-400 px-2 py-1 rounded-full">
            <AlertTriangle className="h-3 w-3" /> {alertCount} Alert{alertCount > 1 ? "s" : ""}
          </span>
        )}
        {lockedCount > 0 && (
          <span className="flex items-center gap-1 text-[10px] bg-red-500/20 text-red-400 px-2 py-1 rounded-full">
            <Shield className="h-3 w-3" /> {lockedCount} Locked
          </span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-2 space-y-1">
        {navItems.map(({ id, label, icon: Icon }) => {
          const active = currentPage === id;
          return (
            <button
              key={id}
              onClick={() => onNavigate(id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                active
                  ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/20"
                  : "text-slate-400 hover:text-white hover:bg-slate-800"
              }`}
            >
              <Icon className="h-4 w-4 flex-shrink-0" />
              {label}
              {active && <ChevronRight className="h-3 w-3 ml-auto opacity-60" />}
            </button>
          );
        })}
      </nav>

      {/* Online nodes */}
      <div className="px-4 py-3 border-t border-slate-800">
        <p className="text-xs text-slate-500 mb-2 uppercase tracking-wider">Live Nodes</p>
        <div className="space-y-1.5">
          {devices.slice(0, 3).map((d) => (
            <div key={d.id} className="flex items-center gap-2 text-xs">
              <span
                className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  d.status === "online"
                    ? "bg-emerald-400"
                    : d.status === "idle"
                    ? "bg-amber-400"
                    : "bg-slate-600"
                }`}
              />
              <span className="text-slate-400 truncate">{d.name}</span>
              <span className="ml-auto text-slate-500 flex-shrink-0">{d.user.split(" ")[0]}</span>
            </div>
          ))}
        </div>
      </div>

      {/* User */}
      <div className="p-4 border-t border-slate-800">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-indigo-500 rounded-full flex items-center justify-center text-xs font-bold text-white">
            A
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white truncate">Admin</p>
            <p className="text-xs text-slate-500">Super Admin</p>
          </div>
          <button className="text-slate-500 hover:text-slate-300 transition-colors">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
