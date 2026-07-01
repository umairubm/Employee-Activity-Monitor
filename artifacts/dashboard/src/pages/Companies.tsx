import React, { useState } from "react";
import {
  useListCompanies,
  getListCompaniesQueryKey,
  useCreateCompany,
  useSuspendCompany,
  useReactivateCompany,
  useGetCompany,
  getGetCompanyQueryKey,
  useAddCompanyAdmin,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Building2, Plus, Ban, Play, Users, SlidersHorizontal } from "lucide-react";
import { format } from "date-fns";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

/** How a company's usage compares to its quota. */
type UsageState = "ok" | "near" | "at" | "unlimited";

function usageState(used: number | undefined, max: number | null | undefined): UsageState {
  if (max == null) return "unlimited";
  if (used == null) return "ok";
  if (used >= max) return "at";
  if (max > 0 && used / max >= 0.8) return "near";
  return "ok";
}

/** How the Companies table is narrowed by usage. */
type UsageFilter = "all" | "near" | "at";

/** True when a company (managers OR devices) is at its quota. */
function companyAtLimit(c: { managerCount?: number; maxManagers?: number | null; deviceCount?: number; maxDevices?: number | null }): boolean {
  return usageState(c.managerCount, c.maxManagers) === "at" || usageState(c.deviceCount, c.maxDevices) === "at";
}

/** True when a company (managers OR devices) is near or at its quota. */
function companyNearOrAtLimit(c: { managerCount?: number; maxManagers?: number | null; deviceCount?: number; maxDevices?: number | null }): boolean {
  const ms = usageState(c.managerCount, c.maxManagers);
  const ds = usageState(c.deviceCount, c.maxDevices);
  return ms === "near" || ms === "at" || ds === "near" || ds === "at";
}

/** A small usage pill like "3 / 5" (or "3 · ∞" when unlimited), flagged by state. */
function UsageCell({
  used,
  max,
  noun,
}: {
  used: number | undefined;
  max: number | null | undefined;
  noun: string;
}) {
  const state = usageState(used, max);
  const usedText = used == null ? "—" : String(used);
  const label = max == null ? `${usedText} · ∞` : `${usedText} / ${max}`;
  return (
    <div className="flex items-center gap-2">
      <Badge
        variant="outline"
        className={cn(
          "font-mono tabular-nums",
          state === "at" && "bg-destructive/10 text-destructive border-destructive/30",
          state === "near" && "bg-amber-500/15 text-amber-700 border-amber-500/30",
        )}
      >
        {label}
      </Badge>
      <span className="text-xs text-muted-foreground">{noun}</span>
      {state === "at" && <span className="text-xs font-medium text-destructive">At limit</span>}
      {state === "near" && <span className="text-xs font-medium text-amber-700">Near limit</span>}
    </div>
  );
}

export default function Companies() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { data: companies, isLoading } = useListCompanies();
  const createCompany = useCreateCompany();
  const suspendCompany = useSuspendCompany();
  const reactivateCompany = useReactivateCompany();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [withAdmin, setWithAdmin] = useState(true);
  const [adminUsername, setAdminUsername] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [usageFilter, setUsageFilter] = useState<UsageFilter>("all");

  const filteredCompanies = companies?.filter((c) => {
    if (usageFilter === "at") return companyAtLimit(c);
    if (usageFilter === "near") return companyNearOrAtLimit(c);
    return true;
  });

  const atLimitCount = companies?.filter(companyAtLimit).length ?? 0;
  const nearOrAtLimitCount = companies?.filter(companyNearOrAtLimit).length ?? 0;

  const resetCreate = () => {
    setName("");
    setWithAdmin(true);
    setAdminUsername("");
    setAdminEmail("");
    setAdminPassword("");
  };

  const handleCreate = () => {
    createCompany.mutate(
      {
        data: {
          name,
          admin:
            withAdmin && adminUsername && adminEmail && adminPassword
              ? { username: adminUsername, email: adminEmail, password: adminPassword }
              : undefined,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCompaniesQueryKey() });
          toast({ title: "Company created" });
          setCreateOpen(false);
          resetCreate();
        },
        onError: () => toast({ title: "Could not create company", description: "Name, username, or email may already be in use.", variant: "destructive" }),
      },
    );
  };

  const setStatus = (id: string, action: "suspend" | "reactivate") => {
    const mut = action === "suspend" ? suspendCompany : reactivateCompany;
    mut.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCompaniesQueryKey() });
          toast({ title: action === "suspend" ? "Company suspended" : "Company reactivated" });
        },
      },
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Companies</h1>
          <p className="text-muted-foreground mt-1">Manage tenant companies across the platform.</p>
        </div>

        <Dialog open={createOpen} onOpenChange={(o) => { setCreateOpen(o); if (!o) resetCreate(); }}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="h-4 w-4" />
              New Company
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Company</DialogTitle>
              <DialogDescription>Provision a new tenant and, optionally, its first Company Admin.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="name">Company name</Label>
                <Input id="name" placeholder="Acme Inc." value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="flex items-center gap-2 pt-2">
                <input id="withAdmin" type="checkbox" checked={withAdmin} onChange={(e) => setWithAdmin(e.target.checked)} className="h-4 w-4" />
                <Label htmlFor="withAdmin" className="cursor-pointer">Create first Company Admin</Label>
              </div>
              {withAdmin && (
                <div className="grid gap-4 rounded-lg border border-border p-3">
                  <div className="grid gap-2">
                    <Label htmlFor="au">Admin username</Label>
                    <Input id="au" value={adminUsername} onChange={(e) => setAdminUsername(e.target.value)} />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="ae">Admin email</Label>
                    <Input id="ae" type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="ap">Admin password</Label>
                    <Input id="ap" type="password" placeholder="At least 8 characters" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} />
                  </div>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={!name || createCompany.isPending}>
                {createCompany.isPending ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">Filter</span>
          <ToggleGroup
            type="single"
            value={usageFilter}
            onValueChange={(v) => setUsageFilter((v as UsageFilter) || "all")}
            variant="outline"
            size="sm"
            className="justify-start"
          >
            <ToggleGroupItem value="all" aria-label="Show all companies">All</ToggleGroupItem>
            <ToggleGroupItem value="near" aria-label="Show companies near or at their limit">Near limit</ToggleGroupItem>
            <ToggleGroupItem value="at" aria-label="Show companies at their limit">At limit</ToggleGroupItem>
          </ToggleGroup>
        </div>

        {!isLoading && (
          <div className="flex items-center gap-2 text-sm">
            {nearOrAtLimitCount === 0 ? (
              <span className="text-muted-foreground">All companies are within their quotas.</span>
            ) : (
              <>
                <span className="text-muted-foreground">Needs attention:</span>
                <button
                  type="button"
                  onClick={() => setUsageFilter("near")}
                  className="focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
                  aria-label={`${nearOrAtLimitCount} companies near or at their limit`}
                >
                  <Badge variant="outline" className="bg-amber-500/15 text-amber-700 border-amber-500/30 tabular-nums">
                    {nearOrAtLimitCount} near or at limit
                  </Badge>
                </button>
                {atLimitCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setUsageFilter("at")}
                    className="focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
                    aria-label={`${atLimitCount} companies at their limit`}
                  >
                    <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/30 tabular-nums">
                      {atLimitCount} at limit
                    </Badge>
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 space-y-4 animate-pulse">
              {[1, 2, 3].map((i) => <div key={i} className="h-12 bg-muted rounded-md" />)}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Managers</TableHead>
                  <TableHead>Devices</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredCompanies?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                      <div className="flex flex-col items-center justify-center">
                        <Building2 className="h-8 w-8 mb-2 opacity-20" />
                        {companies?.length === 0
                          ? "No companies yet."
                          : usageFilter === "at"
                            ? "No companies are at their limit."
                            : usageFilter === "near"
                              ? "No companies are near or at their limit."
                              : "No companies match this filter."}
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredCompanies?.map((c) => {
                    const suspended = c.status === "suspended";
                    const flagged =
                      usageState(c.managerCount, c.maxManagers) === "at" ||
                      usageState(c.managerCount, c.maxManagers) === "near" ||
                      usageState(c.deviceCount, c.maxDevices) === "at" ||
                      usageState(c.deviceCount, c.maxDevices) === "near";
                    return (
                      <TableRow key={c.id} className={suspended ? "opacity-60" : ""}>
                        <TableCell className="font-medium">{c.name}</TableCell>
                        <TableCell>
                          {suspended ? (
                            <Badge variant="destructive">Suspended</Badge>
                          ) : (
                            <Badge className="bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 border-emerald-500/20">Active</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <UsageCell used={c.managerCount} max={c.maxManagers} noun="managers" />
                        </TableCell>
                        <TableCell>
                          <UsageCell used={c.deviceCount} max={c.maxDevices} noun="devices" />
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{format(new Date(c.createdAt), "MMM d, yyyy")}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button variant="ghost" size="sm" className="gap-1" onClick={() => setDetailId(c.id)}>
                              <Users className="h-4 w-4" /> Admins
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className={cn("gap-1", flagged && "text-amber-700")}
                              onClick={() => navigate(`/company-limits?company=${c.id}`)}
                            >
                              <SlidersHorizontal className="h-4 w-4" /> Adjust limits
                            </Button>
                            {suspended ? (
                              <Button variant="ghost" size="sm" className="gap-1 text-emerald-600" onClick={() => setStatus(c.id, "reactivate")}>
                                <Play className="h-4 w-4" /> Reactivate
                              </Button>
                            ) : (
                              <Button variant="ghost" size="sm" className="gap-1 text-destructive" onClick={() => setStatus(c.id, "suspend")}>
                                <Ban className="h-4 w-4" /> Suspend
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <CompanyDetailDialog id={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}

function CompanyDetailDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: company, isLoading } = useGetCompany(id ?? "", {
    query: { enabled: !!id, queryKey: getGetCompanyQueryKey(id ?? "") },
  });
  const addAdmin = useAddCompanyAdmin();

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const handleAdd = () => {
    if (!id) return;
    addAdmin.mutate(
      { id, data: { username, email, password } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetCompanyQueryKey(id) });
          toast({ title: "Admin added" });
          setUsername("");
          setEmail("");
          setPassword("");
        },
        onError: () => toast({ title: "Could not add admin", description: "Username or email may already be in use.", variant: "destructive" }),
      },
    );
  };

  return (
    <Dialog open={!!id} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{company?.name ?? "Company"} — Admins</DialogTitle>
          <DialogDescription>Company Admins can manage this tenant's staff and security policy.</DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="py-6 text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg border border-border divide-y divide-border">
              {company?.admins?.length ? (
                company.admins.map((a) => (
                  <div key={a.id} className="flex items-center justify-between p-3 text-sm">
                    <div>
                      <div className="font-medium">{a.username}</div>
                      <div className="text-muted-foreground text-xs">{a.email}</div>
                    </div>
                    <Badge variant="secondary" className="capitalize">{a.role.replace("_", " ")}</Badge>
                  </div>
                ))
              ) : (
                <div className="p-3 text-sm text-muted-foreground">No admins yet.</div>
              )}
            </div>

            <div className="grid gap-3 rounded-lg border border-border p-3">
              <div className="text-sm font-medium">Add Company Admin</div>
              <Input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
              <Input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <Input type="password" placeholder="Password (8+ chars)" value={password} onChange={(e) => setPassword(e.target.value)} />
              <Button onClick={handleAdd} disabled={!username || !email || !password || addAdmin.isPending}>
                {addAdmin.isPending ? "Adding..." : "Add Admin"}
              </Button>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
