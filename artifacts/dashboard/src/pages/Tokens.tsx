import React, { useState } from "react";
import { useListTokens, getListTokensQueryKey, getListTokenGroupsQueryKey, getListDevicesQueryKey, useListTokenGroups, useListTokenRegions, useCreateToken, useRevokeToken, useRenameDeviceGroup } from "@workspace/api-client-react";
import type { EnrollmentTokenItem } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { KeyRound, Plus, Trash2, Copy, CheckCircle2, Monitor, ChevronsUpDown, Check, Eye, Pencil, FolderSync } from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import EditTokenDialog from "@/components/EditTokenDialog";
import { useGroupFilter, ALL_GROUPS } from "@/hooks/use-group-filter";

// Sentinel value for the "＋ Create new group" option in the group dropdown.
const CREATE_NEW_GROUP = "__create_new__";
// Sentinel values for the region combobox: create-new toggles an inline input,
// undefined leaves the token's region unset (null).
const CREATE_NEW_REGION = "__create_new_region__";
const UNDEFINED_REGION = "__undefined_region__";
// Employee ID: starts alphanumeric, then alphanumeric/hyphen/underscore, 2-64 chars.
const EMPLOYEE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;

// A single token row as returned by the list endpoint (carries every field we
// need for the details view, so no extra request is required).
type TokenRow = EnrollmentTokenItem;

// Derive the lifecycle status of a token from its counters/timestamps.
function tokenStatus(token: TokenRow): "revoked" | "expired" | "exhausted" | "active" {
  if (token.revokedAt) return "revoked";
  if (token.expiresAt && new Date(token.expiresAt) < new Date()) return "expired";
  if (token.useCount >= token.maxUses) return "exhausted";
  return "active";
}

function StatusBadge({ status }: { status: ReturnType<typeof tokenStatus> }) {
  if (status === "revoked") return <Badge variant="destructive">Revoked</Badge>;
  if (status === "expired") return <Badge variant="secondary">Expired</Badge>;
  if (status === "exhausted") return <Badge variant="secondary">Exhausted</Badge>;
  return (
    <Badge className="bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 border-emerald-500/20">
      Active
    </Badge>
  );
}

export default function Tokens() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: tokens, isLoading } = useListTokens();
  const { data: groups } = useListTokenGroups();
  const { data: regions } = useListTokenRegions();
  const createToken = useCreateToken();
  const revokeToken = useRevokeToken();
  const renameGroup = useRenameDeviceGroup();
  const [groupFilter, setGroupFilter] = useGroupFilter();

  const [createOpen, setCreateOpen] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [groupChoice, setGroupChoice] = useState(""); // selected existing group, or CREATE_NEW_GROUP
  const [groupOpen, setGroupOpen] = useState(false); // searchable combobox popover
  const [newGroupName, setNewGroupName] = useState(""); // inline "create new" input
  const [regionChoice, setRegionChoice] = useState(""); // existing region, CREATE_NEW_REGION, or UNDEFINED_REGION
  const [regionOpen, setRegionOpen] = useState(false); // searchable combobox popover
  const [newRegionName, setNewRegionName] = useState(""); // inline "create new" input
  const [maxUses, setMaxUses] = useState("1");
  const [expiresDays, setExpiresDays] = useState("30");
  const [neverExpires, setNeverExpires] = useState(true);
  const [createdTokenStr, setCreatedTokenStr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [detailsToken, setDetailsToken] = useState<TokenRow | null>(null);
  const [editToken, setEditToken] = useState<TokenRow | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameFrom, setRenameFrom] = useState("");
  const [renameTo, setRenameTo] = useState("");

  const creatingNewGroup = groupChoice === CREATE_NEW_GROUP;
  const creatingNewRegion = regionChoice === CREATE_NEW_REGION;
  // Employee ID is optional: blank is fine, but a non-empty value must still
  // match the expected format.
  const employeeIdValid = employeeId.trim() === "" || EMPLOYEE_ID_RE.test(employeeId.trim());
  // The group actually submitted: the typed new name, or the picked existing one.
  const resolvedGroup = creatingNewGroup ? newGroupName.trim() : groupChoice.trim();
  const groupValid = !creatingNewGroup || resolvedGroup.length > 0;
  // The region actually submitted: undefined leaves it unset; create-new uses the
  // typed name; otherwise the picked existing one.
  const resolvedRegion =
    regionChoice === UNDEFINED_REGION || regionChoice === ""
      ? ""
      : creatingNewRegion
        ? newRegionName.trim()
        : regionChoice.trim();
  const regionValid = !creatingNewRegion || resolvedRegion.length > 0;
  const canSubmit = employeeIdValid && groupValid && regionValid && !createToken.isPending;

  const regionTriggerLabel = creatingNewRegion
    ? "New region…"
    : regionChoice === UNDEFINED_REGION
      ? "Undefined"
      : regionChoice || "Select a region";

  const resetForm = () => {
    setNewLabel("");
    setEmployeeId("");
    setGroupChoice("");
    setGroupOpen(false);
    setNewGroupName("");
    setRegionChoice("");
    setRegionOpen(false);
    setNewRegionName("");
    setMaxUses("1");
    setExpiresDays("30");
    setNeverExpires(true);
  };

  const handleCreate = () => {
    if (!canSubmit) return;
    createToken.mutate({
      data: {
        label: newLabel || undefined,
        employeeId: employeeId.trim() || undefined,
        deviceGroup: resolvedGroup || undefined,
        region: resolvedRegion || undefined,
        maxUses: maxUses ? parseInt(maxUses) : undefined,
        expiresDays: neverExpires ? undefined : (expiresDays ? parseInt(expiresDays) : undefined),
      }
    }, {
      onSuccess: (data) => {
        setCreatedTokenStr(data.token); // Plaintext token only available once
        queryClient.invalidateQueries({ queryKey: getListTokensQueryKey() });
        resetForm();
      }
    });
  };

  const openRename = () => {
    setRenameFrom((groups ?? [])[0] ?? "");
    setRenameTo("");
    setRenameOpen(true);
  };

  const handleRename = () => {
    const from = renameFrom.trim();
    const to = renameTo.trim();
    if (!from || !to) return;
    renameGroup.mutate(
      { data: { from, to } },
      {
        onSuccess: (result) => {
          queryClient.invalidateQueries({ queryKey: getListTokensQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListTokenGroupsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListDevicesQueryKey() });
          // Keep the shared team filter pointed at the renamed group so other
          // group-aware pages don't stay pinned to a name that no longer exists.
          if (groupFilter !== ALL_GROUPS && groupFilter === from) setGroupFilter(to);
          toast({
            title: "Group renamed",
            description: `${result.tokensRenamed} token(s) and ${result.renamed} device(s) updated.`,
          });
          setRenameOpen(false);
        },
        onError: (error: any) => {
          toast({ title: "Failed to rename group", description: error.message, variant: "destructive" });
        },
      },
    );
  };

  const handleRevoke = (id: string) => {
    if (!confirm("Are you sure you want to revoke this token? Devices currently using it to enroll will fail.")) return;
    
    revokeToken.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTokensQueryKey() });
        toast({ title: "Token revoked" });
      }
    });
  };

  const handleCopy = () => {
    if (createdTokenStr) {
      navigator.clipboard.writeText(createdTokenStr);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ title: "Copied to clipboard" });
    }
  };

  const closeDialog = () => {
    setCreateOpen(false);
    setCreatedTokenStr(null);
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Enrollment Tokens</h1>
          <p className="text-muted-foreground mt-1">Manage tokens used to enroll new devices to the workspace.</p>
        </div>
        
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="gap-2"
            onClick={openRename}
            disabled={(groups ?? []).length === 0}
          >
            <FolderSync className="h-4 w-4" />
            Rename group
          </Button>
        <Dialog open={createOpen} onOpenChange={(open) => { if(!open) closeDialog(); else setCreateOpen(true); }}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="h-4 w-4" />
              Generate Token
            </Button>
          </DialogTrigger>
          <DialogContent>
            {createdTokenStr ? (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2 text-emerald-600">
                    <CheckCircle2 className="h-5 w-5" />
                    Token Generated Successfully
                  </DialogTitle>
                  <DialogDescription>
                    Copy this token now. You will not be able to see the full token again.
                  </DialogDescription>
                </DialogHeader>
                <div className="my-6 p-4 bg-secondary rounded-lg flex items-center justify-between border border-border">
                  <code className="font-mono text-sm break-all">{createdTokenStr}</code>
                  <Button variant="ghost" size="icon" onClick={handleCopy} className="ml-4 shrink-0">
                    {copied ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <DialogFooter>
                  <Button onClick={closeDialog}>Done</Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle>Generate Enrollment Token</DialogTitle>
                  <DialogDescription>
                    Create a new token to allow devices to enroll.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label htmlFor="employeeId">Employee ID</Label>
                    <Input
                      id="employeeId"
                      placeholder="e.g. EMP-01423"
                      value={employeeId}
                      onChange={e => setEmployeeId(e.target.value)}
                      aria-invalid={employeeId.length > 0 && !employeeIdValid}
                    />
                    {employeeId.length > 0 && !employeeIdValid && (
                      <p className="text-xs text-destructive">
                        2–64 characters: letters, numbers, hyphen or underscore (must start alphanumeric).
                      </p>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="group">Group</Label>
                      <Popover open={groupOpen} onOpenChange={setGroupOpen}>
                        <PopoverTrigger asChild>
                          <Button
                            id="group"
                            type="button"
                            variant="outline"
                            role="combobox"
                            aria-expanded={groupOpen}
                            className="justify-between font-normal"
                          >
                            <span className={groupChoice && !creatingNewGroup ? "" : "text-muted-foreground"}>
                              {creatingNewGroup ? "New group…" : groupChoice || "Select a group"}
                            </span>
                            <ChevronsUpDown className="h-4 w-4 opacity-50 shrink-0" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                          <Command>
                            <CommandInput placeholder="Search groups…" />
                            <CommandList>
                              <CommandEmpty>No matching group.</CommandEmpty>
                              {(groups ?? []).length > 0 && (
                                <CommandGroup>
                                  {(groups ?? []).map(g => (
                                    <CommandItem
                                      key={g}
                                      value={g}
                                      onSelect={() => {
                                        setGroupChoice(g);
                                        setNewGroupName("");
                                        setGroupOpen(false);
                                      }}
                                    >
                                      <Check className={`mr-2 h-4 w-4 ${groupChoice === g ? "opacity-100" : "opacity-0"}`} />
                                      {g}
                                    </CommandItem>
                                  ))}
                                </CommandGroup>
                              )}
                              <CommandSeparator />
                              <CommandGroup>
                                <CommandItem
                                  value="__create_new_group_option__"
                                  onSelect={() => {
                                    setGroupChoice(CREATE_NEW_GROUP);
                                    setGroupOpen(false);
                                  }}
                                >
                                  <Plus className="mr-2 h-4 w-4" />
                                  Create new group…
                                </CommandItem>
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="region">Region</Label>
                      <Popover open={regionOpen} onOpenChange={setRegionOpen}>
                        <PopoverTrigger asChild>
                          <Button
                            id="region"
                            type="button"
                            variant="outline"
                            role="combobox"
                            aria-expanded={regionOpen}
                            className="justify-between font-normal"
                          >
                            <span className={regionChoice && !creatingNewRegion && regionChoice !== UNDEFINED_REGION ? "" : "text-muted-foreground"}>
                              {regionTriggerLabel}
                            </span>
                            <ChevronsUpDown className="h-4 w-4 opacity-50 shrink-0" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                          <Command>
                            <CommandInput placeholder="Search regions…" />
                            <CommandList>
                              <CommandEmpty>No matching region.</CommandEmpty>
                              <CommandGroup>
                                <CommandItem
                                  value="Undefined"
                                  onSelect={() => {
                                    setRegionChoice(UNDEFINED_REGION);
                                    setNewRegionName("");
                                    setRegionOpen(false);
                                  }}
                                >
                                  <Check className={`mr-2 h-4 w-4 ${regionChoice === UNDEFINED_REGION ? "opacity-100" : "opacity-0"}`} />
                                  Undefined
                                </CommandItem>
                              </CommandGroup>
                              {(regions ?? []).length > 0 && (
                                <CommandGroup>
                                  {(regions ?? []).map(r => (
                                    <CommandItem
                                      key={r}
                                      value={r}
                                      onSelect={() => {
                                        setRegionChoice(r);
                                        setNewRegionName("");
                                        setRegionOpen(false);
                                      }}
                                    >
                                      <Check className={`mr-2 h-4 w-4 ${regionChoice === r ? "opacity-100" : "opacity-0"}`} />
                                      {r}
                                    </CommandItem>
                                  ))}
                                </CommandGroup>
                              )}
                              <CommandSeparator />
                              <CommandGroup>
                                <CommandItem
                                  value="__create_new_region_option__"
                                  onSelect={() => {
                                    setRegionChoice(CREATE_NEW_REGION);
                                    setRegionOpen(false);
                                  }}
                                >
                                  <Plus className="mr-2 h-4 w-4" />
                                  Create new region…
                                </CommandItem>
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                    </div>
                  </div>

                  {creatingNewGroup && (
                    <div className="grid gap-2">
                      <Label htmlFor="newGroup">New Group Name</Label>
                      <Input
                        id="newGroup"
                        placeholder="e.g. Finance Floor 2"
                        value={newGroupName}
                        onChange={e => setNewGroupName(e.target.value)}
                        autoFocus
                      />
                      <p className="text-xs text-muted-foreground">
                        Devices enrolled with this token join this group. It becomes selectable for future tokens.
                      </p>
                    </div>
                  )}

                  {creatingNewRegion && (
                    <div className="grid gap-2">
                      <Label htmlFor="newRegion">New Region Name</Label>
                      <Input
                        id="newRegion"
                        placeholder="e.g. APAC"
                        value={newRegionName}
                        onChange={e => setNewRegionName(e.target.value)}
                        autoFocus
                      />
                      <p className="text-xs text-muted-foreground">
                        This region is stored on the token and becomes selectable for future tokens.
                      </p>
                    </div>
                  )}

                  <div className="grid gap-2">
                    <Label htmlFor="label">Label (Optional)</Label>
                    <Input id="label" placeholder="e.g. IT Dept Batch 3" value={newLabel} onChange={e => setNewLabel(e.target.value)} />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="maxUses">Max Uses</Label>
                      <Input id="maxUses" type="number" min="1" value={maxUses} onChange={e => setMaxUses(e.target.value)} />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="expires">Expires In (Days)</Label>
                      <Input id="expires" type="number" min="1" value={expiresDays} onChange={e => setExpiresDays(e.target.value)} disabled={neverExpires} />
                    </div>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border border-border p-3">
                    <div className="space-y-0.5">
                      <Label htmlFor="neverExpires">Never expires</Label>
                      <p className="text-xs text-muted-foreground">Token stays valid until revoked or all uses are spent.</p>
                    </div>
                    <Switch id="neverExpires" checked={neverExpires} onCheckedChange={setNeverExpires} />
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
                  <Button onClick={handleCreate} disabled={!canSubmit}>
                    {createToken.isPending ? "Generating..." : "Generate"}
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
        </div>
      </div>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Rename Group</DialogTitle>
            <DialogDescription>
              Renames the group everywhere it's used — on every enrollment token and device assigned to it.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="rename-from">Existing group</Label>
              <Select value={renameFrom} onValueChange={setRenameFrom}>
                <SelectTrigger id="rename-from">
                  <SelectValue placeholder="Select a group" />
                </SelectTrigger>
                <SelectContent>
                  {(groups ?? []).map((g) => (
                    <SelectItem key={g} value={g}>{g}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="rename-to">New name</Label>
              <Input
                id="rename-to"
                placeholder="e.g. Finance Floor 2"
                value={renameTo}
                onChange={(e) => setRenameTo(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleRename()}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>Cancel</Button>
            <Button onClick={handleRename} disabled={renameGroup.isPending || !renameFrom.trim() || !renameTo.trim()}>
              {renameGroup.isPending ? "Renaming..." : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 space-y-4 animate-pulse">
              {[1, 2, 3].map(i => <div key={i} className="h-12 bg-muted rounded-md"></div>)}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Token / Label</TableHead>
                  <TableHead>Employee / Group / Region</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Uses</TableHead>
                  <TableHead>Enrolled Devices</TableHead>
                  <TableHead>Created by</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="h-32 text-center text-muted-foreground">
                      <div className="flex flex-col items-center justify-center">
                        <KeyRound className="h-8 w-8 mb-2 opacity-20" />
                        No enrollment tokens exist.
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  tokens?.map(token => {
                    const status = tokenStatus(token);
                    const isRevoked = status === "revoked";
                    const isActive = status === "active";

                    return (
                      <TableRow key={token.id} className={!isActive ? "opacity-60" : ""}>
                        <TableCell>
                          <div className="font-mono text-sm">{token.token}</div>
                          {token.label && <div className="text-xs text-muted-foreground mt-1">{token.label}</div>}
                        </TableCell>
                        <TableCell className="text-sm">
                          <div className="flex flex-col gap-1">
                            <span className="font-medium">{token.employeeId ?? <span className="text-muted-foreground">—</span>}</span>
                            <div className="flex flex-wrap gap-1">
                              {token.deviceGroup && <Badge variant="secondary" className="font-normal">{token.deviceGroup}</Badge>}
                              {token.region && <Badge variant="outline" className="font-normal">{token.region}</Badge>}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={status} />
                        </TableCell>
                        <TableCell className="text-sm">
                          {token.useCount} / {token.maxUses}
                        </TableCell>
                        <TableCell className="text-sm">
                          {token.enrolledDevices.length === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <div className="flex flex-wrap gap-1">
                              {token.enrolledDevices.map((d) => (
                                <Badge key={d.id} variant="secondary" className="gap-1 font-normal">
                                  <Monitor className="h-3 w-3" />
                                  {d.systemName}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          {token.createdByUsername ?? <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {format(new Date(token.createdAt), "MMM d, yyyy")}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {token.expiresAt ? format(new Date(token.expiresAt), "MMM d, yyyy") : "Never"}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-muted-foreground hover:text-foreground"
                              onClick={() => setDetailsToken(token)}
                              title="View details"
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-muted-foreground hover:text-foreground"
                              onClick={() => setEditToken(token)}
                              disabled={isRevoked}
                              title={isRevoked ? "Revoked tokens can't be edited" : "Edit token"}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-muted-foreground hover:text-destructive"
                              onClick={() => handleRevoke(token.id)}
                              disabled={isRevoked || revokeToken.isPending}
                              title={isRevoked ? "Already revoked" : "Revoke token"}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
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

      <EditTokenDialog
        token={editToken}
        open={!!editToken}
        onOpenChange={(open) => { if (!open) setEditToken(null); }}
        groups={groups}
        regions={regions}
      />

      <Dialog open={!!detailsToken} onOpenChange={(open) => { if (!open) setDetailsToken(null); }}>
        <DialogContent className="max-w-lg">
          {detailsToken && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <KeyRound className="h-5 w-5" />
                  Token Details
                </DialogTitle>
                <DialogDescription>
                  {detailsToken.label || "Enrollment token"}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-2 text-sm">
                <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/50 p-3">
                  <code className="font-mono break-all">{detailsToken.token}</code>
                  <StatusBadge status={tokenStatus(detailsToken)} />
                </div>

                <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground">Employee ID</dt>
                    <dd className="font-medium">{detailsToken.employeeId || "—"}</dd>
                  </div>
                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground">Uses</dt>
                    <dd className="font-medium">{detailsToken.useCount} / {detailsToken.maxUses}</dd>
                  </div>
                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground">Group</dt>
                    <dd>{detailsToken.deviceGroup ? <Badge variant="secondary" className="font-normal">{detailsToken.deviceGroup}</Badge> : <span className="text-muted-foreground">—</span>}</dd>
                  </div>
                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground">Region</dt>
                    <dd>{detailsToken.region ? <Badge variant="outline" className="font-normal">{detailsToken.region}</Badge> : <span className="text-muted-foreground">Undefined</span>}</dd>
                  </div>
                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground">Created by</dt>
                    <dd className="font-medium">{detailsToken.createdByUsername ?? <span className="text-muted-foreground">—</span>}</dd>
                  </div>
                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground">Created</dt>
                    <dd className="font-medium">{format(new Date(detailsToken.createdAt), "MMM d, yyyy p")}</dd>
                  </div>
                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground">Expires</dt>
                    <dd className="font-medium">{detailsToken.expiresAt ? format(new Date(detailsToken.expiresAt), "MMM d, yyyy p") : "Never"}</dd>
                  </div>
                  {detailsToken.revokedAt && (
                    <div className="space-y-0.5">
                      <dt className="text-xs text-muted-foreground">Revoked</dt>
                      <dd className="font-medium text-destructive">{format(new Date(detailsToken.revokedAt), "MMM d, yyyy p")}</dd>
                    </div>
                  )}
                </dl>

                <div className="space-y-1.5">
                  <div className="text-xs text-muted-foreground">
                    Enrolled Devices ({detailsToken.enrolledDevices.length})
                  </div>
                  {detailsToken.enrolledDevices.length === 0 ? (
                    <p className="text-muted-foreground">No devices have enrolled with this token yet.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {detailsToken.enrolledDevices.map((d) => (
                        <Badge key={d.id} variant="secondary" className="gap-1 font-normal">
                          <Monitor className="h-3 w-3" />
                          {d.systemName}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDetailsToken(null)}>Close</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
