import React, { useState } from "react";
import { useListTokens, getListTokensQueryKey, useListTokenGroups, useCreateToken, useRevokeToken } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { KeyRound, Plus, Trash2, Copy, CheckCircle2, Monitor, ChevronsUpDown, Check } from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";

const REGIONS = ["North", "South", "East", "West"] as const;
// Sentinel value for the "＋ Create new group" option in the group dropdown.
const CREATE_NEW_GROUP = "__create_new__";
// Employee ID: starts alphanumeric, then alphanumeric/hyphen/underscore, 2-64 chars.
const EMPLOYEE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;

export default function Tokens() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: tokens, isLoading } = useListTokens();
  const { data: groups } = useListTokenGroups();
  const createToken = useCreateToken();
  const revokeToken = useRevokeToken();

  const [createOpen, setCreateOpen] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [groupChoice, setGroupChoice] = useState(""); // selected existing group, or CREATE_NEW_GROUP
  const [groupOpen, setGroupOpen] = useState(false); // searchable combobox popover
  const [newGroupName, setNewGroupName] = useState(""); // inline "create new" input
  const [region, setRegion] = useState("");
  const [maxUses, setMaxUses] = useState("1");
  const [expiresDays, setExpiresDays] = useState("30");
  const [neverExpires, setNeverExpires] = useState(true);
  const [createdTokenStr, setCreatedTokenStr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const creatingNewGroup = groupChoice === CREATE_NEW_GROUP;
  const employeeIdValid = EMPLOYEE_ID_RE.test(employeeId.trim());
  // The group actually submitted: the typed new name, or the picked existing one.
  const resolvedGroup = creatingNewGroup ? newGroupName.trim() : groupChoice.trim();
  const groupValid = !creatingNewGroup || resolvedGroup.length > 0;
  const canSubmit = employeeIdValid && groupValid && !createToken.isPending;

  const resetForm = () => {
    setNewLabel("");
    setEmployeeId("");
    setGroupChoice("");
    setGroupOpen(false);
    setNewGroupName("");
    setRegion("");
    setMaxUses("1");
    setExpiresDays("30");
    setNeverExpires(true);
  };

  const handleCreate = () => {
    if (!canSubmit) return;
    createToken.mutate({
      data: {
        label: newLabel || undefined,
        employeeId: employeeId.trim(),
        deviceGroup: resolvedGroup || undefined,
        region: (region || undefined) as (typeof REGIONS)[number] | undefined,
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
                    <Label htmlFor="employeeId">Employee ID <span className="text-destructive">*</span></Label>
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
                      <Select value={region} onValueChange={setRegion}>
                        <SelectTrigger id="region">
                          <SelectValue placeholder="Select a region" />
                        </SelectTrigger>
                        <SelectContent>
                          {REGIONS.map(r => (
                            <SelectItem key={r} value={r}>{r}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
                  <TableHead>Created</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="h-32 text-center text-muted-foreground">
                      <div className="flex flex-col items-center justify-center">
                        <KeyRound className="h-8 w-8 mb-2 opacity-20" />
                        No enrollment tokens exist.
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  tokens?.map(token => {
                    const isRevoked = !!token.revokedAt;
                    const isExpired = token.expiresAt ? new Date(token.expiresAt) < new Date() : false;
                    const isExhausted = token.useCount >= token.maxUses;
                    const isActive = !isRevoked && !isExpired && !isExhausted;

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
                          {isRevoked ? <Badge variant="destructive">Revoked</Badge> :
                           isExpired ? <Badge variant="secondary">Expired</Badge> :
                           isExhausted ? <Badge variant="secondary">Exhausted</Badge> :
                           <Badge className="bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 border-emerald-500/20">Active</Badge>}
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
                        <TableCell className="text-sm text-muted-foreground">
                          {format(new Date(token.createdAt), "MMM d, yyyy")}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {token.expiresAt ? format(new Date(token.expiresAt), "MMM d, yyyy") : "Never"}
                        </TableCell>
                        <TableCell className="text-right">
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
    </div>
  );
}
