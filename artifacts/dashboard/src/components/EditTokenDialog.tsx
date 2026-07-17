import React, { useEffect, useState } from "react";
import { useUpdateToken } from "@workspace/api-client-react";
import type { EnrollmentTokenItem } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { ChevronsUpDown, Check, Plus } from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";

// Employee ID: starts alphanumeric, then alphanumeric/hyphen/underscore, 2-64 chars.
const EMPLOYEE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;

const CREATE_NEW_GROUP = "__create_new__";
const CREATE_NEW_REGION = "__create_new_region__";
const UNDEFINED_REGION = "__undefined_region__";

type TokenRow = EnrollmentTokenItem;

// Turn a token's expiresAt into the yyyy-MM-dd string the date input needs.
function toDateInput(value: string | Date | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : format(d, "yyyy-MM-dd");
}

export default function EditTokenDialog({
  token,
  open,
  onOpenChange,
  groups,
  regions,
}: {
  token: TokenRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: string[] | undefined;
  regions: string[] | undefined;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateToken = useUpdateToken();

  const [label, setLabel] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [groupChoice, setGroupChoice] = useState(""); // existing group or CREATE_NEW_GROUP
  const [groupOpen, setGroupOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [regionChoice, setRegionChoice] = useState(""); // existing, CREATE_NEW_REGION, or UNDEFINED_REGION
  const [regionOpen, setRegionOpen] = useState(false);
  const [newRegionName, setNewRegionName] = useState("");
  const [maxUses, setMaxUses] = useState("1");
  const [expiresDate, setExpiresDate] = useState(""); // yyyy-MM-dd
  const [neverExpires, setNeverExpires] = useState(true);

  // Re-seed the form each time a token is opened for editing.
  useEffect(() => {
    if (!token) return;
    setLabel(token.label ?? "");
    setEmployeeId(token.employeeId ?? "");
    setGroupChoice(token.deviceGroup ?? "");
    setNewGroupName("");
    setGroupOpen(false);
    setRegionChoice(token.region ?? UNDEFINED_REGION);
    setNewRegionName("");
    setRegionOpen(false);
    setMaxUses(String(token.maxUses));
    setExpiresDate(toDateInput(token.expiresAt));
    setNeverExpires(!token.expiresAt);
  }, [token]);

  const creatingNewGroup = groupChoice === CREATE_NEW_GROUP;
  const creatingNewRegion = regionChoice === CREATE_NEW_REGION;
  // Employee ID is optional: blank clears it, but a non-empty value must still
  // match the expected format.
  const employeeIdValid = employeeId.trim() === "" || EMPLOYEE_ID_RE.test(employeeId.trim());

  const resolvedGroup = creatingNewGroup ? newGroupName.trim() : groupChoice.trim();
  const groupValid = !creatingNewGroup || resolvedGroup.length > 0;

  const resolvedRegion =
    regionChoice === UNDEFINED_REGION || regionChoice === ""
      ? ""
      : creatingNewRegion
        ? newRegionName.trim()
        : regionChoice.trim();
  const regionValid = !creatingNewRegion || resolvedRegion.length > 0;

  const maxUsesNum = parseInt(maxUses, 10);
  const maxUsesValid =
    Number.isFinite(maxUsesNum) &&
    maxUsesNum >= 1 &&
    maxUsesNum <= 1000 &&
    (!token || maxUsesNum >= token.useCount);
  const expiryValid = neverExpires || expiresDate.length > 0;

  const canSubmit =
    !!token &&
    employeeIdValid &&
    groupValid &&
    regionValid &&
    maxUsesValid &&
    expiryValid &&
    !updateToken.isPending;

  const regionTriggerLabel = creatingNewRegion
    ? "New region…"
    : regionChoice === UNDEFINED_REGION
      ? "Undefined"
      : regionChoice || "Select a region";

  const handleSave = () => {
    if (!token || !canSubmit) return;
    updateToken.mutate(
      {
        id: token.id,
        data: {
          label: label.trim() ? label.trim() : null,
          employeeId: employeeId.trim() ? employeeId.trim() : null,
          deviceGroup: resolvedGroup ? resolvedGroup : null,
          region: resolvedRegion ? resolvedRegion : null,
          maxUses: maxUsesNum,
          expiresAt: neverExpires ? null : new Date(`${expiresDate}T23:59:59`).toISOString(),
        },
      },
      {
        onSuccess: () => {
          // A group edit propagates server-side to every device enrolled via
          // this token, and each screen derives its group from its own device
          // data query. Invalidate the whole cache so all screens (devices,
          // activity, attendance, screenshots, reports, overview) refetch and
          // reflect the new group — not just the Tokens screen.
          queryClient.invalidateQueries();
          toast({ title: "Token updated" });
          onOpenChange(false);
        },
        onError: (err) => {
          toast({
            title: "Update failed",
            description: (err as Error).message,
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Enrollment Token</DialogTitle>
          <DialogDescription>
            Update any field below. The token value itself cannot be changed.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="edit-employeeId">Employee ID</Label>
            <Input
              id="edit-employeeId"
              placeholder="e.g. EMP-01423"
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
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
              <Label htmlFor="edit-group">Group</Label>
              <Popover open={groupOpen} onOpenChange={setGroupOpen}>
                <PopoverTrigger asChild>
                  <Button
                    id="edit-group"
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
                          {(groups ?? []).map((g) => (
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
              <Label htmlFor="edit-region">Region</Label>
              <Popover open={regionOpen} onOpenChange={setRegionOpen}>
                <PopoverTrigger asChild>
                  <Button
                    id="edit-region"
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
                          {(regions ?? []).map((r) => (
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
              <Label htmlFor="edit-newGroup">New Group Name</Label>
              <Input
                id="edit-newGroup"
                placeholder="e.g. Finance Floor 2"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                autoFocus
              />
            </div>
          )}

          {creatingNewRegion && (
            <div className="grid gap-2">
              <Label htmlFor="edit-newRegion">New Region Name</Label>
              <Input
                id="edit-newRegion"
                placeholder="e.g. APAC"
                value={newRegionName}
                onChange={(e) => setNewRegionName(e.target.value)}
                autoFocus
              />
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor="edit-label">Label (Optional)</Label>
            <Input id="edit-label" placeholder="e.g. IT Dept Batch 3" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="edit-maxUses">Max Uses</Label>
              <Input id="edit-maxUses" type="number" min="1" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} aria-invalid={!maxUsesValid} />
              {token && !maxUsesValid && (
                <p className="text-xs text-destructive">
                  Must be between {token.useCount || 1} and 1000 (not below uses already spent).
                </p>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-expires">Expires On</Label>
              <Input id="edit-expires" type="date" value={expiresDate} onChange={(e) => setExpiresDate(e.target.value)} disabled={neverExpires} />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="edit-neverExpires">Never expires</Label>
              <p className="text-xs text-muted-foreground">Token stays valid until revoked or all uses are spent.</p>
            </div>
            <Switch id="edit-neverExpires" checked={neverExpires} onCheckedChange={setNeverExpires} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={!canSubmit}>
            {updateToken.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
