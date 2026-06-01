import React, { useState } from "react";
import { useGetActivityLogs, getGetActivityLogsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { format } from "date-fns";
import { Activity, Search, Clock, AppWindow } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function ActivityLogs() {
  const [search, setSearch] = useState("");
  const { data: logs, isLoading } = useGetActivityLogs({ limit: 100 }, { query: { queryKey: getGetActivityLogsQueryKey({ limit: 100 }) } });

  const formatDuration = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  };

  const filteredLogs = logs?.filter(log => 
    log.processName.toLowerCase().includes(search.toLowerCase()) || 
    (log.windowTitle && log.windowTitle.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Activity Logs</h1>
          <p className="text-muted-foreground mt-1">Detailed foreground application usage across devices.</p>
        </div>
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input 
            type="search" 
            placeholder="Search processes or window titles..." 
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
                  <TableHead>Application</TableHead>
                  <TableHead>Window Title</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Idle</TableHead>
                  <TableHead>Started</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredLogs?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                      <div className="flex flex-col items-center justify-center">
                        <Activity className="h-8 w-8 mb-2 opacity-20" />
                        No activity logs found.
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredLogs?.map(log => (
                    <TableRow key={log.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <AppWindow className="h-4 w-4 text-muted-foreground" />
                          {log.processName}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm max-w-xs truncate" title={log.windowTitle || ""}>
                        {log.windowTitle || "-"}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="font-mono bg-secondary/50">
                          {formatDuration(log.durationSeconds)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className={`text-sm ${log.idleSeconds > 0 ? 'text-amber-600 dark:text-amber-500 font-medium' : 'text-muted-foreground'}`}>
                          {log.idleSeconds > 0 ? formatDuration(log.idleSeconds) : "Active"}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        <div className="flex items-center gap-1.5">
                          <Clock className="h-3.5 w-3.5" />
                          {format(new Date(log.startedAt), "MMM d, HH:mm:ss")}
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
    </div>
  );
}
