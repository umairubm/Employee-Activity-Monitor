import React from "react";
import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from "@tanstack/react-query";
import { ApiError, getGetCurrentUserQueryKey } from "@workspace/api-client-react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { Shell } from "@/components/layout/Shell";
import { Loader2, ShieldAlert } from "lucide-react";

import Login from "@/pages/Login";
import Overview from "@/pages/Overview";
import Devices from "@/pages/Devices";
import DeviceDetail from "@/pages/DeviceDetail";
import ActivityLogs from "@/pages/ActivityLogs";
import Screenshots from "@/pages/Screenshots";
import Categories from "@/pages/Categories";
import Tokens from "@/pages/Tokens";
import NotFound from "@/pages/not-found";

const ADMIN_ROLES = ["super_user", "admin"];

// When any query or mutation fails with a 401 (expired/cleared session),
// drop the cached current-user so the AuthProvider falls back to the login
// screen instead of leaving the app in a broken authenticated-looking state.
function handleUnauthorized(error: unknown) {
  if (error instanceof ApiError && error.status === 401) {
    queryClient.setQueryData(getGetCurrentUserQueryKey(), null);
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleUnauthorized }),
  mutationCache: new MutationCache({ onError: handleUnauthorized }),
});

function ProtectedRoute({ component: Component, ...rest }: any) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background">
        <Loader2 className="animate-spin text-primary h-8 w-8" />
      </div>
    );
  }

  if (!user) {
    return <Redirect to="/login" />;
  }

  if (!ADMIN_ROLES.includes(user.role)) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background p-4">
        <div className="w-full max-w-md text-center bg-card border border-border rounded-xl shadow-lg p-8">
          <div className="w-12 h-12 rounded-xl bg-destructive/10 text-destructive flex items-center justify-center mx-auto mb-4">
            <ShieldAlert size={28} />
          </div>
          <h1 className="text-xl font-bold tracking-tight">Access restricted</h1>
          <p className="text-sm text-muted-foreground mt-2">
            This console is available to administrators only. Your account does
            not have the required permissions.
          </p>
        </div>
      </div>
    );
  }

  return (
    <Shell>
      <Component {...rest} />
    </Shell>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/">
        {(params) => <ProtectedRoute component={Overview} />}
      </Route>
      <Route path="/devices">
        {(params) => <ProtectedRoute component={Devices} />}
      </Route>
      <Route path="/devices/:id">
        {(params) => <ProtectedRoute component={DeviceDetail} id={params.id} />}
      </Route>
      <Route path="/activity">
        {(params) => <ProtectedRoute component={ActivityLogs} />}
      </Route>
      <Route path="/screenshots">
        {(params) => <ProtectedRoute component={Screenshots} />}
      </Route>
      <Route path="/categories">
        {(params) => <ProtectedRoute component={Categories} />}
      </Route>
      <Route path="/tokens">
        {(params) => <ProtectedRoute component={Tokens} />}
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AuthProvider>
            <Router />
          </AuthProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
