import React from "react";
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from "@tanstack/react-query";
import { ApiError, getGetCurrentUserQueryKey } from "@workspace/api-client-react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/lib/auth";
import { useAuth } from "@/lib/auth-context";
import { Shell } from "@/components/layout/Shell";
import { APP_ROUTES, canAccess, defaultRouteForRole, type AppRoute } from "@/lib/navigation";
import { Loader2, ShieldAlert } from "lucide-react";

import Login from "@/pages/Login";
import NotFound from "@/pages/not-found";

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

function AccessRestricted() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md text-center bg-card border border-border rounded-xl shadow-lg p-8">
        <div className="w-12 h-12 rounded-xl bg-destructive/10 text-destructive flex items-center justify-center mx-auto mb-4">
          <ShieldAlert size={28} />
        </div>
        <h1 className="text-xl font-bold tracking-tight">Access restricted</h1>
        <p className="text-sm text-muted-foreground mt-2">
          Your account does not have permission to view this page.
        </p>
      </div>
    </div>
  );
}

function ProtectedRoute({ route, params }: { route: AppRoute; params: Record<string, string> }) {
  const { user, isLoading } = useAuth();
  const [location] = useLocation();

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

  if (!canAccess(route, user)) {
    // Send the user to their preferred landing page, or — when page
    // permissions lock that down too — the first page they can access.
    // Only when no page at all is accessible does the account truly have
    // no console access.
    const home = defaultRouteForRole(user.role);
    const fallback =
      home && APP_ROUTES.some((r) => r.href === home && canAccess(r, user))
        ? home
        : APP_ROUTES.find((r) => r.nav && canAccess(r, user))?.href;
    if (fallback && fallback !== location) {
      return <Redirect to={fallback} />;
    }
    return <AccessRestricted />;
  }

  const Component = route.component;
  return (
    <Shell>
      <Component {...params} />
    </Shell>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      {APP_ROUTES.map((route) => (
        <Route key={route.href} path={route.href}>
          {(params) => <ProtectedRoute route={route} params={params as Record<string, string>} />}
        </Route>
      ))}
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
