import React, { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useLogin, useResetPassword, getGetCurrentUserQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ShieldCheck, Loader2, Eye, EyeOff } from "lucide-react";

const loginSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

type LoginFormData = z.infer<typeof loginSchema>;

const resetSchema = z.object({
  username: z.string().min(1, "Username is required"),
  code: z.string().min(1, "Reset code is required"),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

type ResetFormData = z.infer<typeof resetSchema>;

function ForgotPasswordForm({ onBack }: { onBack: () => void }) {
  const resetMutation = useResetPassword();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const { register, handleSubmit, formState: { errors } } = useForm<ResetFormData>({
    resolver: zodResolver(resetSchema),
  });

  const onSubmit = (data: ResetFormData) => {
    setErrorMsg(null);
    resetMutation.mutate({ data }, {
      onSuccess: () => setDone(true),
      onError: (err: any) => {
        setErrorMsg(err?.data?.error || err.message || "Invalid or expired reset code");
      },
    });
  };

  if (done) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-sm">
          Your password has been updated. You can now sign in with your new password.
        </p>
        <Button className="w-full" onClick={onBack}>Back to Sign In</Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Ask your administrator for a one-time reset code, then enter it below with
        your username and a new password.
      </p>
      <div>
        <label className="block text-sm font-medium mb-1.5" htmlFor="reset-username">Username</label>
        <Input
          id="reset-username"
          placeholder="your username"
          {...register("username")}
          className={errors.username ? "border-destructive focus-visible:ring-destructive" : ""}
        />
        {errors.username && <p className="text-destructive text-xs mt-1">{errors.username.message}</p>}
      </div>
      <div>
        <label className="block text-sm font-medium mb-1.5" htmlFor="reset-code">Reset code</label>
        <Input
          id="reset-code"
          placeholder="XXXX-XXXX"
          autoComplete="one-time-code"
          {...register("code")}
          className={`font-mono uppercase ${errors.code ? "border-destructive focus-visible:ring-destructive" : ""}`}
        />
        {errors.code && <p className="text-destructive text-xs mt-1">{errors.code.message}</p>}
      </div>
      <div>
        <label className="block text-sm font-medium mb-1.5" htmlFor="reset-password">New password</label>
        <Input
          id="reset-password"
          type="password"
          placeholder="At least 8 characters"
          autoComplete="new-password"
          {...register("newPassword")}
          className={errors.newPassword ? "border-destructive focus-visible:ring-destructive" : ""}
        />
        {errors.newPassword && <p className="text-destructive text-xs mt-1">{errors.newPassword.message}</p>}
      </div>

      {errorMsg && (
        <div className="p-3 bg-destructive/10 text-destructive text-sm rounded-md border border-destructive/20">
          {errorMsg}
        </div>
      )}

      <Button type="submit" className="w-full" disabled={resetMutation.isPending}>
        {resetMutation.isPending ? <Loader2 className="animate-spin mr-2" size={18} /> : null}
        Set New Password
      </Button>
      <button
        type="button"
        onClick={onBack}
        className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        Back to Sign In
      </button>
    </form>
  );
}

export default function Login() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const loginMutation = useLogin();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [forgotMode, setForgotMode] = useState(false);

  const { register, handleSubmit, formState: { errors } } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
  });

  const onSubmit = (data: LoginFormData) => {
    setErrorMsg(null);
    loginMutation.mutate({ data }, {
      onSuccess: (user) => {
        queryClient.setQueryData(getGetCurrentUserQueryKey(), user);
        setLocation("/");
      },
      onError: (err: any) => {
        setErrorMsg(err.message || "Invalid credentials");
      }
    });
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md bg-card border border-border rounded-xl shadow-lg p-8 animate-in fade-in zoom-in-95 duration-500">
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-primary flex items-center justify-center text-primary-foreground mb-4">
            <ShieldCheck size={28} />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">
            {forgotMode ? "Reset Password" : "Welcome Back"}
          </h1>
          <p className="text-sm text-muted-foreground mt-1 text-center">
            {forgotMode
              ? "Use the one-time code from your administrator."
              : "Sign in to the Workforce operations console."}
          </p>
        </div>

        {forgotMode ? (
          <ForgotPasswordForm onBack={() => setForgotMode(false)} />
        ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="username">Username</label>
            <Input 
              id="username" 
              placeholder="admin" 
              {...register("username")}
              className={errors.username ? "border-destructive focus-visible:ring-destructive" : ""}
            />
            {errors.username && <p className="text-destructive text-xs mt-1">{errors.username.message}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="password">Password</label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                placeholder="••••••••"
                {...register("password")}
                className={`pr-10 ${errors.password ? "border-destructive focus-visible:ring-destructive" : ""}`}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:text-foreground"
              >
                {showPassword ? <Eye size={18} /> : <EyeOff size={18} />}
              </button>
            </div>
            {errors.password && <p className="text-destructive text-xs mt-1">{errors.password.message}</p>}
          </div>

          {errorMsg && (
            <div className="p-3 bg-destructive/10 text-destructive text-sm rounded-md border border-destructive/20">
              {errorMsg}
            </div>
          )}

          <Button 
            type="submit" 
            className="w-full mt-2" 
            disabled={loginMutation.isPending}
          >
            {loginMutation.isPending ? <Loader2 className="animate-spin mr-2" size={18} /> : null}
            Sign In
          </Button>
          <button
            type="button"
            onClick={() => setForgotMode(true)}
            className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors mt-1"
          >
            Forgot password?
          </button>
        </form>
        )}
      </div>
    </div>
  );
}
