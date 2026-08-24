import React, { useMemo, useState } from "react";
import { useListCategories, getListCategoriesQueryKey, useUpdateCategory, useListDevices } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Tags, Search, Loader2, MonitorSmartphone, FolderOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

const ALL_GROUPS = "__all__";
const ALL_DEVICES = "__all__";

export default function Categories() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [groupFilter, setGroupFilter] = useState<string>(ALL_GROUPS);
  const [deviceFilter, setDeviceFilter] = useState<string>(ALL_DEVICES);

  const { data: devices } = useListDevices();

  const groups = useMemo(() => {
    const set = new Set<string>();
    devices?.forEach((d) => set.add(d.deviceGroup));
    return Array.from(set).sort();
  }, [devices]);

  // Devices offered in the device dropdown honour the group selection.
  const selectableDevices = useMemo(() => {
    const list = devices ?? [];
    const scoped = groupFilter === ALL_GROUPS ? list : list.filter((d) => d.deviceGroup === groupFilter);
    return [...scoped].sort((a, b) => a.systemName.localeCompare(b.systemName));
  }, [devices, groupFilter]);

  // A concrete device is the most specific filter; otherwise fall back to the group.
  const listParams = useMemo(() => {
    if (deviceFilter !== ALL_DEVICES) return { deviceId: deviceFilter };
    if (groupFilter !== ALL_GROUPS) return { deviceGroup: groupFilter };
    return undefined;
  }, [deviceFilter, groupFilter]);

  const { data: categories, isLoading } = useListCategories(listParams);
  const updateCategory = useUpdateCategory();

  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const handleGroupChange = (value: string) => {
    setGroupFilter(value);
    // Reset the device selection when it no longer belongs to the chosen group.
    if (value !== ALL_GROUPS) {
      const stillValid = devices?.some((d) => d.id === deviceFilter && d.deviceGroup === value);
      if (!stillValid) setDeviceFilter(ALL_DEVICES);
    }
  };

  const filteredCategories = categories?.filter(c => 
    c.pattern.toLowerCase().includes(search.toLowerCase()) || 
    c.displayName.toLowerCase().includes(search.toLowerCase())
  );

  const handleClassificationChange = (id: string, value: string) => {
    updateCategory.mutate({ 
      id, 
      data: { classification: value as any } 
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
        toast({ title: "Classification updated" });
      }
    });
  };

  const handleNameEdit = (id: string, currentName: string) => {
    setEditingId(id);
    setEditName(currentName);
  };

  const handleNameSave = (id: string) => {
    if (!editName.trim()) {
      setEditingId(null);
      return;
    }
    
    updateCategory.mutate({ 
      id, 
      data: { displayName: editName } 
    }, {
      onSuccess: () => {
        setEditingId(null);
        queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey() });
      }
    });
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">App Categories</h1>
          <p className="text-muted-foreground mt-1">Classify process names for productivity analytics.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={groupFilter} onValueChange={handleGroupChange}>
            <SelectTrigger className="w-[170px]" aria-label="Filter by group">
              <FolderOpen className="h-4 w-4 mr-1.5 text-muted-foreground shrink-0" />
              <SelectValue placeholder="All groups" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_GROUPS}>All groups</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g} value={g}>{g}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={deviceFilter} onValueChange={setDeviceFilter}>
            <SelectTrigger className="w-[200px]" aria-label="Filter by device">
              <MonitorSmartphone className="h-4 w-4 mr-1.5 text-muted-foreground shrink-0" />
              <SelectValue placeholder="All devices" />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              <SelectItem value={ALL_DEVICES}>All devices</SelectItem>
              {selectableDevices.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.tokenLabel ? `${d.systemName} (${d.tokenLabel})` : d.systemName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input 
              type="search" 
              placeholder="Search processes..." 
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 space-y-4 animate-pulse">
              {[1, 2, 3, 4, 5].map(i => <div key={i} className="h-12 bg-muted rounded-md"></div>)}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[300px]">Process Pattern</TableHead>
                  <TableHead className="w-[300px]">Display Name</TableHead>
                  <TableHead>Classification</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredCategories?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="h-32 text-center text-muted-foreground">
                      <div className="flex flex-col items-center justify-center">
                        <Tags className="h-8 w-8 mb-2 opacity-20" />
                        No categories found. New apps are added automatically.
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredCategories?.map(category => (
                    <TableRow key={category.id}>
                      <TableCell className="font-mono text-sm text-muted-foreground">
                        {category.pattern}
                      </TableCell>
                      <TableCell>
                        {editingId === category.id ? (
                          <Input 
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onBlur={() => handleNameSave(category.id)}
                            onKeyDown={(e) => e.key === 'Enter' && handleNameSave(category.id)}
                            autoFocus
                            className="h-8 py-1"
                            disabled={updateCategory.isPending && updateCategory.variables?.id === category.id}
                          />
                        ) : (
                          <div 
                            className="cursor-pointer hover:bg-secondary/50 p-1.5 -ml-1.5 rounded-md transition-colors"
                            onClick={() => handleNameEdit(category.id, category.displayName)}
                          >
                            {category.displayName}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Select 
                          value={category.classification} 
                          onValueChange={(val) => handleClassificationChange(category.id, val)}
                          disabled={updateCategory.isPending && updateCategory.variables?.id === category.id}
                        >
                          <SelectTrigger className={`w-[180px] h-8 ${
                            category.classification === 'productive' ? 'bg-primary/10 text-primary border-primary/20' :
                            category.classification === 'unproductive' ? 'bg-destructive/10 text-destructive border-destructive/20' :
                            category.classification === 'neutral' ? 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' :
                            ''
                          }`}>
                            <SelectValue placeholder="Select classification" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="productive">Productive</SelectItem>
                            <SelectItem value="neutral">Neutral</SelectItem>
                            <SelectItem value="unproductive">Unproductive</SelectItem>
                            <SelectItem value="undefined">Undefined</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
