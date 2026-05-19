import * as React from "react";
import {
  Camera,
  Search,
  Filter,
  Calendar as CalendarIcon,
  Download,
  Trash2,
  Eye,
  Monitor,
  Clock,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

// Mock Screenshots Data
const mockScreenshots = [
  {
    id: "1",
    user: "Hassan Raza",
    device: "DELL-68",
    capturedAt: "09:54:30",
    app: "VS Code",
    type: "desktop",
    size: "1.2 MB",
  },
  {
    id: "2",
    user: "Hassan Raza",
    device: "DELL-68",
    capturedAt: "09:44:15",
    app: "Google Chrome",
    type: "desktop",
    size: "850 KB",
  },
  {
    id: "3",
    user: "Sarah Smith",
    device: "MAC-PRO-01",
    capturedAt: "09:39:00",
    app: "Figma",
    type: "desktop",
    size: "2.1 MB",
  },
  {
    id: "4",
    user: "Hassan Raza",
    device: "DELL-68",
    capturedAt: "09:34:00",
    app: "Slack",
    type: "desktop",
    size: "600 KB",
  },
  {
    id: "5",
    user: "John Doe",
    device: "DESKTOP-FK",
    capturedAt: "09:20:00",
    app: "Unknown",
    type: "camera",
    size: "400 KB",
    isCamera: true,
  },
  {
    id: "6",
    user: "Sarah Smith",
    device: "MAC-PRO-01",
    capturedAt: "09:15:00",
    app: "VS Code",
    type: "desktop",
    size: "1.5 MB",
  },
];

export function Preview() {
  const [searchTerm, setSearchTerm] = React.useState("");

  return (
    <div className="min-h-screen bg-slate-50/50 dark:bg-slate-900 p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-white">Screenshots & Media</h1>
          <p className="text-slate-500 dark:text-slate-400">Browse captured visual logs from monitored nodes</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" className="bg-white dark:bg-slate-800">
            <CalendarIcon className="mr-2 h-4 w-4" /> Today
          </Button>
          <Button variant="outline" className="bg-white dark:bg-slate-800">
            <Filter className="mr-2 h-4 w-4" /> Filter
          </Button>
          <Button className="bg-indigo-600 hover:bg-indigo-700 text-white">
            <Camera className="mr-2 h-4 w-4" /> Trigger Capture
          </Button>
        </div>
      </div>

      {/* Filter Bar */}
      <Card className="bg-white dark:bg-slate-800 border-none shadow-sm">
        <CardContent className="p-4 flex flex-col md:flex-row gap-4 items-center justify-between">
          <div className="relative w-full md:w-[300px]">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <Input
              type="search"
              placeholder="Search by user or app..."
              className="pl-8 bg-slate-50 dark:bg-slate-700 border-none"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <div className="flex gap-2 items-center text-sm text-slate-500">
            <span>Type:</span>
            <Badge variant="secondary" className="cursor-pointer">All</Badge>
            <Badge variant="outline" className="cursor-pointer hover:bg-slate-100">Desktop</Badge>
            <Badge variant="outline" className="cursor-pointer hover:bg-slate-100">Camera</Badge>
          </div>
        </CardContent>
      </Card>

      {/* Grid of Screenshots */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {mockScreenshots.map((shot) => (
          <Card key={shot.id} className="bg-white dark:bg-slate-800 border-none shadow-sm overflow-hidden group">
            {/* Image Container */}
            <div className="relative aspect-video bg-slate-100 dark:bg-slate-700 flex items-center justify-center border-b border-slate-100 dark:border-slate-700">
              {shot.isCamera ? (
                <div className="text-center text-slate-400">
                  <Camera className="h-10 w-10 mx-auto mb-2 opacity-50" />
                  <p className="text-xs">Stealth Camera Frame</p>
                </div>
              ) : (
                <div className="text-center text-slate-400">
                  <Monitor className="h-10 w-10 mx-auto mb-2 opacity-50" />
                  <p className="text-xs">Desktop Screenshot</p>
                </div>
              )}
              
              {/* Hover Overlay */}
              <div className="absolute inset-0 bg-slate-900/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                <Button size="sm" className="bg-white text-slate-900 hover:bg-slate-100">
                  <Eye className="h-4 w-4 mr-1" /> View
                </Button>
                <Button size="sm" variant="outline" className="text-white border-white hover:bg-white/20">
                  <Download className="h-4 w-4 mr-1" /> Download
                </Button>
              </div>
            </div>

            {/* Content */}
            <CardContent className="p-4">
              <div className="flex justify-between items-start mb-2">
                <div>
                  <h3 className="font-semibold text-slate-900 dark:text-white text-sm">{shot.user}</h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{shot.device}</p>
                </div>
                <Badge variant={shot.isCamera ? "secondary" : "outline"} className="text-xs">
                  {shot.app}
                </Badge>
              </div>

              <div className="flex justify-between items-center text-xs text-slate-500 dark:text-slate-400">
                <div className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {shot.capturedAt}
                </div>
                <span>{shot.size}</span>
              </div>
            </CardContent>
            
            {/* Footer with Actions */}
            <CardFooter className="px-4 py-3 bg-slate-50 dark:bg-slate-850 border-t border-slate-100 dark:border-slate-700 flex justify-between items-center">
              <span className="text-xs text-slate-400">ID: {shot.id}</span>
              <Button size="icon" variant="ghost" className="h-8 w-8 text-slate-400 hover:text-red-500">
                <Trash2 className="h-4 w-4" />
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>
    </div>
  );
}

export default Preview;
