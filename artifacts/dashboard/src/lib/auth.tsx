import { useEffect, ReactNode } from "react";
import { useGetCurrentUser, getGetCurrentUserQueryKey, ApiError } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { AuthContext } from "@/lib/auth-context";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  const { data: user, isLoading, error } = useGetCurrentUser({
    query: {
      retry: false,
      queryKey: getGetCurrentUserQueryKey(),
    }
  });

  const isError = !!error;

  useEffect(() => {
    if (error instanceof ApiError && error.status === 401 && location !== "/login") {
      setLocation("/login");
    }
  }, [error, location, setLocation]);

  return (
    <AuthContext.Provider value={{ user: user || null, isLoading, isError }}>
      {children}
    </AuthContext.Provider>
  );
}
