import React from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth-context";
import { LogOut, ShieldCheck } from "lucide-react";
import { useLogout, getGetCurrentUserQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { APP_ROUTES, canAccess } from "@/lib/navigation";

export function Shell({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const logout = useLogout();

  const navItems = APP_ROUTES.filter(
    (route) => route.nav && canAccess(route, user?.role),
  );

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
      <aside className="w-full lg:w-64 border-r border-border bg-card flex flex-col flex-shrink-0 lg:sticky lg:top-0 lg:h-screen">
        <div className="p-6 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground">
            <ShieldCheck size={20} />
          </div>
          <span className="font-bold tracking-tight">Workforce</span>
        </div>
        
        <nav className="flex-1 px-4 flex flex-col gap-1 overflow-y-auto">
          {navItems.map((item) => {
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
      <main className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-border bg-card px-4 md:px-8 py-3 flex-shrink-0">
          <div className="text-sm text-muted-foreground hidden sm:block">
            Welcome back,{" "}
            <span className="font-semibold text-foreground">{user?.username ?? "User"}</span>
          </div>
          <div className="flex items-center gap-3 ml-auto">
            <div className="flex flex-col items-end leading-tight">
              {user?.companyName && (
                <span className="text-xs font-semibold text-foreground truncate max-w-[14rem]">
                  {user.companyName}
                </span>
              )}
              <span className="text-sm font-medium truncate max-w-[12rem]">{user?.username ?? "User"}</span>
              <span className="text-xs text-muted-foreground capitalize truncate">
                {user?.role?.replace("_", " ")}
              </span>
            </div>
            <div className="w-9 h-9 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-semibold flex-shrink-0">
              {user?.username?.charAt(0).toUpperCase() ?? "U"}
            </div>
          </div>
        </header>
        <div className="flex-1 p-4 md:p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
