import React, { useState } from "react";
import {
  useListManagers,
  getListManagersQueryKey,
  useCreateManager,
  useUpdateManager,
  useDeleteManager,
  useGenerateManagerResetCode,
  type CompanyUser,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { UsersRound, Plus, Pencil, Trash2, KeyRound } from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import {
  PAGE_PERMISSION_KEYS,
  type PagePermissions,
  type PagePermissionLevel,
} from "@/lib/navigation";

type Role = "manager" | "team_member";

/**
 * Per-page access editor. `perms === null` means "full access" (no
 * restriction); otherwise each page is No access / View / View & edit.
 */
function PagePermissionsEditor({
  perms,
  onChange,
}: {
  perms: PagePermissions | null;
  onChange: (next: PagePermissions | null) => void;
}) {
  const restricted = perms !== null;
  const setLevel = (key: string, level: PagePermissionLevel | "none") => {
    const next: PagePermissions = { ...(perms ?? {}) };
    if (level === "none") {
      delete next[key as keyof PagePermissions];
    } else {
      next[key as keyof PagePermissions] = level;
    }
    onChange(next);
  };
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2">
        <input
          id="restrict-pages"
          type="checkbox"
          className="h-4 w-4"
          checked={restricted}
          onChange={(e) => onChange(e.target.checked ? {} : null)}
        />
        <Label htmlFor="restrict-pages" className="cursor-pointer">
          Restrict page access
        </Label>
      </div>
      {restricted ? (
        <div className="max-h-56 overflow-y-auto rounded-lg border border-border divide-y divide-border">
          {PAGE_PERMISSION_KEYS.map(({ key, label }) => (
            <div key={key} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span>{label}</span>
              <select
                aria-label={`Access for ${label}`}
                value={perms?.[key] ?? "none"}
                onChange={(e) => setLevel(key, e.target.value as PagePermissionLevel | "none")}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              >
                <option value="none">No access</option>
                <option value="view">View only</option>
                <option value="edit">View &amp; edit</option>
              </select>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Full access: this user can see and edit every page their role allows.
        </p>
      )}
    </div>
  );
}

export default function Managers() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: users, isLoading } = useListManagers();
  const createUser = useCreateManager();
  const updateUser = useUpdateManager();
  const deleteUser = useDeleteManager();
  const generateResetCode = useGenerateManagerResetCode();
  const [resetCodeInfo, setResetCodeInfo] = useState<{
    username: string;
    code: string;
    expiresAt: string;
  } | null>(null);

  const handleResetCode = (u: CompanyUser) => {
    generateResetCode.mutate(
      { id: u.id },
      {
        onSuccess: (r) =>
          setResetCodeInfo({ username: u.username, code: r.code, expiresAt: r.expiresAt }),
        onError: () =>
          toast({ title: "Could not generate reset code", variant: "destructive" }),
      },
    );
  };

  const [createOpen, setCreateOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("manager");
  const [perms, setPerms] = useState<PagePermissions | null>(null);

  const [editing, setEditing] = useState<CompanyUser | null>(null);
  const [editEmail, setEditEmail] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [editRole, setEditRole] = useState<Role>("manager");
  const [editPerms, setEditPerms] = useState<PagePermissions | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListManagersQueryKey() });

  const resetCreate = () => {
    setUsername("");
    setEmail("");
    setPassword("");
    setRole("manager");
    setPerms(null);
  };

  const handleCreate = () => {
    if (password.length < 8) {
      toast({
        title: "Password too short",
        description: "The password must be at least 8 characters.",
        variant: "destructive",
      });
      return;
    }
    createUser.mutate(
      { data: { username, email, password, role, pagePermissions: perms } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "User created" });
          setCreateOpen(false);
          resetCreate();
        },
        onError: (err) => {
          const serverMsg = (err as { data?: { error?: string } })?.data?.error;
          toast({
            title: "Could not create user",
            description:
              serverMsg ?? "Username or email may already be in use.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const openEdit = (u: CompanyUser) => {
    setEditing(u);
    setEditEmail(u.email);
    setEditPassword("");
    setEditRole(u.role === "team_member" ? "team_member" : "manager");
    setEditPerms((u.pagePermissions as PagePermissions | null | undefined) ?? null);
  };

  const handleUpdate = () => {
    if (!editing) return;
    if (editPassword && editPassword.length < 8) {
      toast({
        title: "Password too short",
        description: "The new password must be at least 8 characters.",
        variant: "destructive",
      });
      return;
    }
    updateUser.mutate(
      {
        id: editing.id,
        data: {
          email: editEmail !== editing.email ? editEmail : undefined,
          password: editPassword || undefined,
          role: editRole,
          pagePermissions: editPerms,
        },
      },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "User updated" });
          setEditing(null);
        },
        onError: () => toast({ title: "Could not update user", variant: "destructive" }),
      },
    );
  };

  const handleDelete = (id: string) => {
    if (!confirm("Remove this user? They will lose access immediately.")) return;
    deleteUser.mutate(
      { id },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "User removed" });
        },
      },
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Team & Managers</h1>
          <p className="text-muted-foreground mt-1">Manage the managers and team members in your company.</p>
        </div>

        <Dialog open={createOpen} onOpenChange={(o) => { setCreateOpen(o); if (!o) resetCreate(); }}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="h-4 w-4" />
              New User
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create User</DialogTitle>
              <DialogDescription>Add a manager or team member to your company.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="u">Username</Label>
                <Input id="u" value={username} onChange={(e) => setUsername(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="e">Email</Label>
                <Input id="e" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="p">Password</Label>
                <Input id="p" type="password" placeholder="At least 8 characters" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="r">Role</Label>
                <select id="r" value={role} onChange={(e) => setRole(e.target.value as Role)} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
                  <option value="manager">Manager</option>
                  <option value="team_member">Team member</option>
                </select>
              </div>
              <PagePermissionsEditor perms={perms} onChange={setPerms} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={!username || !email || !password || createUser.isPending}>
                {createUser.isPending ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
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
                  <TableHead>User</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                      <div className="flex flex-col items-center justify-center">
                        <UsersRound className="h-8 w-8 mb-2 opacity-20" />
                        No managers or team members yet.
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  users?.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell className="font-medium">{u.username}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{u.email}</TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="capitalize">{u.role.replace("_", " ")}</Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {u.createdAt ? format(new Date(u.createdAt), "MMM d, yyyy") : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="icon" onClick={() => openEdit(u)} title="Edit">
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleResetCode(u)}
                            disabled={generateResetCode.isPending}
                            title="Generate password reset code"
                          >
                            <KeyRound className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" onClick={() => handleDelete(u.id)} title="Remove">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!resetCodeInfo} onOpenChange={(o) => { if (!o) setResetCodeInfo(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Password reset code for {resetCodeInfo?.username}</DialogTitle>
            <DialogDescription>
              Share this one-time code with the user. They can use it on the login
              page (&ldquo;Forgot password?&rdquo;) to set a new password. It expires in
              30 minutes and is shown only once.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div className="rounded-lg border border-border bg-muted/50 p-4 text-center font-mono text-2xl tracking-widest select-all">
              {resetCodeInfo?.code}
            </div>
            <p className="text-xs text-muted-foreground mt-2 text-center">
              Expires {resetCodeInfo ? format(new Date(resetCodeInfo.expiresAt), "MMM d, yyyy h:mm a") : ""}
            </p>
          </div>
          <DialogFooter>
            <Button onClick={() => setResetCodeInfo(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {editing?.username}</DialogTitle>
            <DialogDescription>Update this user's email, password, or role.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="ee">Email</Label>
              <Input id="ee" type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ep">New password</Label>
              <Input id="ep" type="password" placeholder="Leave blank to keep current" value={editPassword} onChange={(e) => setEditPassword(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="er">Role</Label>
              <select id="er" value={editRole} onChange={(e) => setEditRole(e.target.value as Role)} className="h-10 rounded-md border border-input bg-background px-3 text-sm">
                <option value="manager">Manager</option>
                <option value="team_member">Team member</option>
              </select>
            </div>
            <PagePermissionsEditor perms={editPerms} onChange={setEditPerms} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={handleUpdate} disabled={updateUser.isPending}>
              {updateUser.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
