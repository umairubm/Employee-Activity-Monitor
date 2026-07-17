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
  useUpdateCompany,
  type Company,
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
import { Building2, Plus, Ban, Play, Users, SlidersHorizontal, Search, ArrowUp, ArrowDown, ChevronsUpDown, Pencil } from "lucide-react";
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

/** Which column the Companies table is sorted by. */
type SortColumn = "name" | "managers" | "devices" | "created";
type SortDirection = "asc" | "desc";

/**
 * True when a company (managers OR devices) is at its quota.
 * Suspended companies never count — they don't consume active quota that needs
 * Super User attention, so they're excluded from both counts and the usage filter.
 */
function companyAtLimit(c: { status?: string; managerCount?: number; maxManagers?: number | null; deviceCount?: number; maxDevices?: number | null }): boolean {
  if (c.status === "suspended") return false;
  return usageState(c.managerCount, c.maxManagers) === "at" || usageState(c.deviceCount, c.maxDevices) === "at";
}

/**
 * True when a company (managers OR devices) is near or at its quota.
 * Suspended companies are excluded (see {@link companyAtLimit}).
 */
function companyNearOrAtLimit(c: { status?: string; managerCount?: number; maxManagers?: number | null; deviceCount?: number; maxDevices?: number | null }): boolean {
  if (c.status === "suspended") return false;
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

/** A clickable table header that toggles sorting and shows the active direction. */
function SortableHead({
  column,
  label,
  sortColumn,
  sortDirection,
  onSort,
  className,
}: {
  column: SortColumn;
  label: string;
  sortColumn: SortColumn | null;
  sortDirection: SortDirection;
  onSort: (column: SortColumn) => void;
  className?: string;
}) {
  const active = sortColumn === column;
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className="inline-flex items-center gap-1 -mx-1 px-1 rounded-md hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
        aria-label={`Sort by ${label}${active ? (sortDirection === "asc" ? ", currently ascending" : ", currently descending") : ""}`}
      >
        {label}
        {active ? (
          sortDirection === "asc" ? (
            <ArrowUp className="h-3.5 w-3.5" />
          ) : (
            <ArrowDown className="h-3.5 w-3.5" />
          )
        ) : (
          <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />
        )}
      </button>
    </TableHead>
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
  const [editingCompany, setEditingCompany] = useState<Company | null>(null);
  const [usageFilter, setUsageFilter] = useState<UsageFilter>("all");
  const [query, setQuery] = useState("");
  const [sortColumn, setSortColumn] = useState<SortColumn | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  const toggleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  };

  const trimmedQuery = query.trim().toLowerCase();
  const filteredCompanies = companies?.filter((c) => {
    if (trimmedQuery && !c.name.toLowerCase().includes(trimmedQuery)) return false;
    if (usageFilter === "at") return companyAtLimit(c);
    if (usageFilter === "near") return companyNearOrAtLimit(c);
    return true;
  });

  const sortedCompanies = sortColumn && filteredCompanies
    ? [...filteredCompanies].sort((a, b) => {
        const dir = sortDirection === "asc" ? 1 : -1;
        switch (sortColumn) {
          case "name":
            return a.name.localeCompare(b.name) * dir;
          case "managers":
            return ((a.managerCount ?? 0) - (b.managerCount ?? 0)) * dir;
          case "devices":
            return ((a.deviceCount ?? 0) - (b.deviceCount ?? 0)) * dir;
          case "created":
            return (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * dir;
          default:
            return 0;
        }
      })
    : filteredCompanies;

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
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="relative sm:w-64">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search companies…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-8"
              aria-label="Search companies by name"
            />
          </div>
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
                  <SortableHead column="name" label="Company" sortColumn={sortColumn} sortDirection={sortDirection} onSort={toggleSort} />
                  <TableHead>Status</TableHead>
                  <SortableHead column="managers" label="Managers" sortColumn={sortColumn} sortDirection={sortDirection} onSort={toggleSort} />
                  <SortableHead column="devices" label="Devices" sortColumn={sortColumn} sortDirection={sortDirection} onSort={toggleSort} />
                  <TableHead>Expires</TableHead>
                  <SortableHead column="created" label="Created" sortColumn={sortColumn} sortDirection={sortDirection} onSort={toggleSort} />
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredCompanies?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                      <div className="flex flex-col items-center justify-center">
                        <Building2 className="h-8 w-8 mb-2 opacity-20" />
                        {companies?.length === 0
                          ? "No companies yet."
                          : trimmedQuery
                            ? usageFilter === "at"
                              ? `No companies at their limit match “${query.trim()}”.`
                              : usageFilter === "near"
                                ? `No companies near or at their limit match “${query.trim()}”.`
                                : `No companies match “${query.trim()}”.`
                            : usageFilter === "at"
                              ? "No companies are at their limit."
                              : usageFilter === "near"
                                ? "No companies are near or at their limit."
                                : "No companies match this filter."}
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  sortedCompanies?.map((c) => {
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
                        <TableCell className="text-sm">
                          {c.expiresAt == null ? (
                            <span className="text-muted-foreground">Never</span>
                          ) : new Date(c.expiresAt).getTime() <= Date.now() ? (
                            <Badge variant="destructive">Expired {format(new Date(c.expiresAt), "MMM d, yyyy")}</Badge>
                          ) : (
                            <span>{format(new Date(c.expiresAt), "MMM d, yyyy")}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{format(new Date(c.createdAt), "MMM d, yyyy")}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button variant="ghost" size="sm" className="gap-1" onClick={() => setEditingCompany(c)}>
                              <Pencil className="h-4 w-4" /> Edit
                            </Button>
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
      <EditCompanyDialog company={editingCompany} onClose={() => setEditingCompany(null)} />
    </div>
  );
}

/** Convert a Date (or ISO string) to the yyyy-MM-dd value an <input type="date"> expects. */
function toDateInputValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : format(d, "yyyy-MM-dd");
}

function EditCompanyDialog({ company, onClose }: { company: Company | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateCompany = useUpdateCompany();

  const [name, setName] = useState("");
  const [neverExpires, setNeverExpires] = useState(true);
  const [expiryDate, setExpiryDate] = useState("");

  // Load the selected company's values whenever the dialog opens.
  React.useEffect(() => {
    if (!company) return;
    setName(company.name);
    setNeverExpires(company.expiresAt == null);
    setExpiryDate(toDateInputValue(company.expiresAt));
  }, [company]);

  const handleSave = () => {
    if (!company) return;
    // Expire at the END of the chosen day, local time, so "expires Jul 31"
    // still allows sign-in on Jul 31.
    const expiresAt = neverExpires
      ? null
      : new Date(`${expiryDate}T23:59:59`).toISOString();
    updateCompany.mutate(
      { id: company.id, data: { name: name.trim(), expiresAt } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListCompaniesQueryKey() });
          toast({ title: "Company updated" });
          onClose();
        },
        onError: (err) => {
          const serverMsg = (err as { data?: { error?: string } })?.data?.error;
          toast({
            title: "Could not update company",
            description: serverMsg ?? "The name may already be in use.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const invalid = !name.trim() || (!neverExpires && !expiryDate);

  return (
    <Dialog open={!!company} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {company?.name}</DialogTitle>
          <DialogDescription>Rename this company or set when its account expires.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="ecn">Company name</Label>
            <Input id="ecn" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>Account expiry</Label>
            <div className="flex items-center gap-2">
              <input
                id="never-expires"
                type="checkbox"
                className="h-4 w-4"
                checked={neverExpires}
                onChange={(e) => setNeverExpires(e.target.checked)}
              />
              <Label htmlFor="never-expires" className="cursor-pointer font-normal">
                Never expires (unlimited)
              </Label>
            </div>
            {!neverExpires && (
              <Input
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
                aria-label="Expiry date"
              />
            )}
            <p className="text-xs text-muted-foreground">
              After this date, everyone in the company is locked out until you extend or clear the expiry.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={invalid || updateCompany.isPending}>
            {updateCompany.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
