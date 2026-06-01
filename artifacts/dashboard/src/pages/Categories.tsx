import React, { useState } from "react";
import { useListCategories, getListCategoriesQueryKey, useUpdateCategory } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Tags, Search, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

export default function Categories() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: categories, isLoading } = useListCategories();
  const updateCategory = useUpdateCategory();
  
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

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
