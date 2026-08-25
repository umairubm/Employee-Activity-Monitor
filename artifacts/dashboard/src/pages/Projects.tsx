import React, { useState } from "react";
import {
  useListProjects,
  getListProjectsQueryKey,
  useCreateProject,
  useUpdateProject,
  useDeleteProject,
  useListProjectTasks,
  getListProjectTasksQueryKey,
  useCreateTask,
  useUpdateTask,
  useDeleteTask,
  useListUsers,
  type ProjectItem,
  type TaskItem,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  FolderKanban,
  Plus,
  Trash2,
  ChevronRight,
  ChevronDown,
  Loader2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ViewToggle, useViewMode } from "@/components/ViewToggle";

const PROJECT_STATUS = [
  { value: "active", label: "Active" },
  { value: "on_hold", label: "On Hold" },
  { value: "completed", label: "Completed" },
  { value: "archived", label: "Archived" },
] as const;

const TASK_STATUS = [
  { value: "todo", label: "To Do" },
  { value: "in_progress", label: "In Progress" },
  { value: "done", label: "Done" },
] as const;

const TASK_PRIORITY = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
] as const;

function statusBadge(status: string) {
  switch (status) {
    case "active":
      return "bg-emerald-500/15 text-emerald-700 border-emerald-500/20";
    case "on_hold":
      return "bg-amber-500/15 text-amber-700 border-amber-500/20";
    case "completed":
      return "bg-sky-500/15 text-sky-700 border-sky-500/20";
    default:
      return "bg-slate-500/15 text-slate-600 border-slate-500/20";
  }
}

function priorityBadge(p: string) {
  switch (p) {
    case "high":
      return "bg-destructive/10 text-destructive border-destructive/20";
    case "medium":
      return "bg-amber-500/10 text-amber-700 border-amber-500/20";
    default:
      return "bg-slate-500/10 text-slate-600 border-slate-500/20";
  }
}

function fmtHours(minutes: number) {
  if (!minutes) return "0h";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export default function Projects() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [viewMode, setViewMode] = useViewMode("projects");
  const { data: projects, isLoading } = useListProjects(
    statusFilter === "all" ? undefined : { status: statusFilter as never },
  );

  const createProject = useCreateProject();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [client, setClient] = useState("");
  const [description, setDescription] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const refetchProjects = () =>
    queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });

  const handleCreate = () => {
    if (!name.trim()) return;
    createProject.mutate(
      {
        data: {
          name: name.trim(),
          client: client.trim() || null,
          description: description.trim() || null,
        },
      },
      {
        onSuccess: () => {
          refetchProjects();
          setName("");
          setClient("");
          setDescription("");
          setCreateOpen(false);
          toast({ title: "Project created" });
        },
      },
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Projects & Tasks</h1>
          <p className="text-muted-foreground mt-1">
            Plan projects, assign tasks, and track logged time against estimates.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ViewToggle mode={viewMode} onChange={setViewMode} />
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {PROJECT_STATUS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="h-4 w-4" />
                New Project
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Project</DialogTitle>
                <DialogDescription>
                  Group related work and track progress across tasks.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                  <Label htmlFor="p-name">Name</Label>
                  <Input
                    id="p-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Website Redesign"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="p-client">Client (optional)</Label>
                  <Input
                    id="p-client"
                    value={client}
                    onChange={(e) => setClient(e.target.value)}
                    placeholder="e.g. Acme Corp"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="p-desc">Description (optional)</Label>
                  <Textarea
                    id="p-desc"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={3}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={handleCreate}
                  disabled={createProject.isPending || !name.trim()}
                >
                  {createProject.isPending ? "Creating..." : "Create"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 space-y-4 animate-pulse">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 bg-muted rounded-md"></div>
              ))}
            </div>
          ) : viewMode === "table" ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[40px]"></TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead>Tasks</TableHead>
                  <TableHead>Logged / Est.</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects?.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="h-32 text-center text-muted-foreground"
                    >
                      <div className="flex flex-col items-center justify-center">
                        <FolderKanban className="h-8 w-8 mb-2 opacity-20" />
                        No projects yet. Create one to get started.
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  projects?.map((project) => (
                    <ProjectRow
                      key={project.id}
                      project={project}
                      expanded={expanded === project.id}
                      onToggle={() =>
                        setExpanded(expanded === project.id ? null : project.id)
                      }
                      onChanged={refetchProjects}
                    />
                  ))
                )}
              </TableBody>
            </Table>
          ) : projects?.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center text-muted-foreground">
              <FolderKanban className="mb-2 h-8 w-8 opacity-20" />
              No projects yet. Create one to get started.
            </div>
          ) : (
            <div className="grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-3">
              {projects?.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  expanded={expanded === project.id}
                  onToggle={() => setExpanded(expanded === project.id ? null : project.id)}
                  onChanged={refetchProjects}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ProjectCard({
  project,
  expanded,
  onToggle,
  onChanged,
}: {
  project: ProjectItem;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();
  const { toast } = useToast();
  const handleDelete = () => {
    if (!confirm(`Delete "${project.name}" and all of its tasks? This cannot be undone.`)) return;
    deleteProject.mutate({ id: project.id }, {
      onSuccess: () => {
        onChanged();
        toast({ title: "Project deleted" });
      },
    });
  };
  return (
    <Card className={expanded ? "sm:col-span-2 xl:col-span-3" : undefined}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <button type="button" className="min-w-0 text-left" onClick={onToggle}>
            <span className="flex items-center gap-2 font-semibold">
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              {project.name}
            </span>
            {project.client && <span className="ml-6 text-xs text-muted-foreground">{project.client}</span>}
          </button>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={handleDelete} disabled={deleteProject.isPending} title="Delete project">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="mb-1 text-xs text-muted-foreground">Status</p>
            <Select value={project.status} onValueChange={(status) => updateProject.mutate({ id: project.id, data: { status: status as never } }, { onSuccess: onChanged })}>
              <SelectTrigger className={`h-8 w-32 ${statusBadge(project.status)}`}><SelectValue /></SelectTrigger>
              <SelectContent>{PROJECT_STATUS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div><p className="text-xs text-muted-foreground">Tasks</p><p>{project.doneCount}/{project.taskCount}</p></div>
          <div className="col-span-2">
            <div className="flex justify-between text-xs text-muted-foreground"><span>Progress</span><span>{project.completionPct}%</span></div>
            <Progress value={project.completionPct} className="mt-1 h-2" />
          </div>
          <div className="col-span-2"><p className="text-xs text-muted-foreground">Logged / Estimated</p><p>{fmtHours(project.loggedMinutes)} / {fmtHours(project.estimatedMinutes)}</p></div>
        </div>
        {expanded && (
          <div className="mt-4 border-t">
            <TaskPanel projectId={project.id} onChanged={() => {
              queryClient.invalidateQueries({ queryKey: getListProjectTasksQueryKey(project.id) });
              onChanged();
            }} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProjectRow({
  project,
  expanded,
  onToggle,
  onChanged,
}: {
  project: ProjectItem;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();

  const handleStatus = (status: string) => {
    updateProject.mutate(
      { id: project.id, data: { status: status as never } },
      { onSuccess: onChanged },
    );
  };

  const handleDelete = () => {
    if (
      !confirm(
        `Delete "${project.name}" and all of its tasks? This cannot be undone.`,
      )
    )
      return;
    deleteProject.mutate(
      { id: project.id },
      {
        onSuccess: () => {
          onChanged();
          toast({ title: "Project deleted" });
        },
      },
    );
  };

  return (
    <>
      <TableRow className="cursor-pointer" onClick={onToggle}>
        <TableCell>
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </TableCell>
        <TableCell>
          <div className="font-medium">{project.name}</div>
          {project.client && (
            <div className="text-xs text-muted-foreground">{project.client}</div>
          )}
        </TableCell>
        <TableCell onClick={(e) => e.stopPropagation()}>
          <Select value={project.status} onValueChange={handleStatus}>
            <SelectTrigger
              className={`w-32 h-8 ${statusBadge(project.status)}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROJECT_STATUS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-2 w-36">
            <Progress value={project.completionPct} className="h-2" />
            <span className="text-xs text-muted-foreground w-9 text-right">
              {project.completionPct}%
            </span>
          </div>
        </TableCell>
        <TableCell className="text-sm">
          <span className="text-muted-foreground">
            {project.doneCount}/{project.taskCount}
          </span>
        </TableCell>
        <TableCell className="text-sm text-muted-foreground">
          {fmtHours(project.loggedMinutes)} / {fmtHours(project.estimatedMinutes)}
        </TableCell>
        <TableCell
          className="text-right"
          onClick={(e) => e.stopPropagation()}
        >
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-destructive"
            onClick={handleDelete}
            disabled={deleteProject.isPending}
            title="Delete project"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell colSpan={7} className="p-0">
            <TaskPanel
              projectId={project.id}
              onChanged={() => {
                queryClient.invalidateQueries({
                  queryKey: getListProjectTasksQueryKey(project.id),
                });
                onChanged();
              }}
            />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function TaskPanel({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const { data: tasks, isLoading } = useListProjectTasks(projectId);
  const { data: users } = useListUsers();
  const createTask = useCreateTask();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const [viewMode, setViewMode] = useViewMode("project-tasks");

  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("medium");
  const [assignee, setAssignee] = useState("none");
  const [estHours, setEstHours] = useState("");

  const handleAdd = () => {
    if (!title.trim()) return;
    createTask.mutate(
      {
        id: projectId,
        data: {
          title: title.trim(),
          priority: priority as never,
          assignedUserId: assignee === "none" ? null : assignee,
          estimatedMinutes: estHours ? Math.round(parseFloat(estHours) * 60) : 0,
        },
      },
      {
        onSuccess: () => {
          onChanged();
          setTitle("");
          setPriority("medium");
          setAssignee("none");
          setEstHours("");
        },
      },
    );
  };

  const patch = (task: TaskItem, data: Record<string, unknown>) => {
    updateTask.mutate({ id: task.id, data: data as never }, { onSuccess: onChanged });
  };

  const handleDelete = (task: TaskItem) => {
    deleteTask.mutate(
      { id: task.id },
      {
        onSuccess: () => {
          onChanged();
          toast({ title: "Task deleted" });
        },
      },
    );
  };

  return (
    <div className="p-4 space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[200px]">
          <Label className="text-xs">New task</Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder="Task title"
            className="h-9"
          />
        </div>
        <Select value={priority} onValueChange={setPriority}>
          <SelectTrigger className="w-28 h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TASK_PRIORITY.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={assignee} onValueChange={setAssignee}>
          <SelectTrigger className="w-40 h-9">
            <SelectValue placeholder="Assignee" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Unassigned</SelectItem>
            {users?.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.username}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="number"
          min="0"
          step="0.5"
          value={estHours}
          onChange={(e) => setEstHours(e.target.value)}
          placeholder="Est. hrs"
          className="w-24 h-9"
        />
        <Button onClick={handleAdd} disabled={createTask.isPending || !title.trim()} className="h-9 gap-1">
          <Plus className="h-4 w-4" />
          Add
        </Button>
        <ViewToggle mode={viewMode} onChange={setViewMode} />
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading tasks...
        </div>
      ) : tasks?.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">No tasks yet.</p>
      ) : viewMode === "table" ? (
        <div className="rounded-md border border-border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Task</TableHead>
                <TableHead className="w-32">Status</TableHead>
                <TableHead className="w-28">Priority</TableHead>
                <TableHead className="w-40">Assignee</TableHead>
                <TableHead className="w-36">Logged (hrs)</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks?.map((task) => (
                <TableRow key={task.id}>
                  <TableCell>
                    <div className="font-medium text-sm">{task.title}</div>
                    {task.estimatedMinutes > 0 && (
                      <div className="text-xs text-muted-foreground">
                        Est. {fmtHours(task.estimatedMinutes)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={task.status}
                      onValueChange={(v) => patch(task, { status: v })}
                    >
                      <SelectTrigger className="h-8 w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TASK_STATUS.map((s) => (
                          <SelectItem key={s.value} value={s.value}>
                            {s.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={priorityBadge(task.priority)}>
                      {task.priority}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={task.assignedUserId ?? "none"}
                      onValueChange={(v) =>
                        patch(task, { assignedUserId: v === "none" ? null : v })
                      }
                    >
                      <SelectTrigger className="h-8 w-36">
                        <SelectValue placeholder="Unassigned" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Unassigned</SelectItem>
                        {users?.map((u) => (
                          <SelectItem key={u.id} value={u.id}>
                            {u.username}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      min="0"
                      step="0.25"
                      defaultValue={(task.loggedMinutes / 60).toString()}
                      onBlur={(e) => {
                        const hrs = parseFloat(e.target.value);
                        const minutes = Number.isFinite(hrs)
                          ? Math.max(0, Math.round(hrs * 60))
                          : 0;
                        if (minutes !== task.loggedMinutes) {
                          patch(task, { loggedMinutes: minutes });
                        }
                      }}
                      className="h-8 w-24"
                    />
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => handleDelete(task)}
                      disabled={deleteTask.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {tasks?.map((task) => (
            <Card key={task.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium text-sm">{task.title}</p>
                    <p className="text-xs text-muted-foreground">Estimated {task.estimatedMinutes > 0 ? fmtHours(task.estimatedMinutes) : "0h"}</p>
                  </div>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => handleDelete(task)} disabled={deleteTask.isPending} title="Delete task">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <div className="mt-3 grid gap-3">
                  <div><Label className="text-xs">Status</Label><Select value={task.status} onValueChange={(v) => patch(task, { status: v })}><SelectTrigger className="mt-1 h-8"><SelectValue /></SelectTrigger><SelectContent>{TASK_STATUS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent></Select></div>
                  <div><Label className="text-xs">Priority</Label><div className="mt-1"><Badge variant="outline" className={priorityBadge(task.priority)}>{task.priority}</Badge></div></div>
                  <div><Label className="text-xs">Assignee</Label><Select value={task.assignedUserId ?? "none"} onValueChange={(v) => patch(task, { assignedUserId: v === "none" ? null : v })}><SelectTrigger className="mt-1 h-8"><SelectValue placeholder="Unassigned" /></SelectTrigger><SelectContent><SelectItem value="none">Unassigned</SelectItem>{users?.map((u) => <SelectItem key={u.id} value={u.id}>{u.username}</SelectItem>)}</SelectContent></Select></div>
                  <div><Label className="text-xs">Logged (hrs)</Label><Input type="number" min="0" step="0.25" defaultValue={(task.loggedMinutes / 60).toString()} onBlur={(e) => { const hrs = parseFloat(e.target.value); const minutes = Number.isFinite(hrs) ? Math.max(0, Math.round(hrs * 60)) : 0; if (minutes !== task.loggedMinutes) patch(task, { loggedMinutes: minutes }); }} className="mt-1 h-8" /></div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
