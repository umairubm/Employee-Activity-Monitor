import { createContext, useContext } from "react";
import { AuthUser } from "@workspace/api-client-react";

export interface AuthContextType {
  user: AuthUser | null;
  isLoading: boolean;
  isError: boolean;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
