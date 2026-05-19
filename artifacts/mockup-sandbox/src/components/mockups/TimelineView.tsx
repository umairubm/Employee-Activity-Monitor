import * as React from "react";
import {
  Clock,
  Monitor,
  MousePointer,
  Keyboard,
  Shield,
  Search,
  Filter,
  Calendar as CalendarIcon,
  ChevronDown,
  Info,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

// Mock Timeline Data
const timelineEvents = [
  {
    id: "1",
    time: "09:54:33",
    duration: "10m 0s",
    app: "VS Code",
    window: "src/App.tsx - employee-monitor",
    type: "productive",
    icon: Monitor,
    category: "Development",
  },
  {
    id: "2",
    time: "09:44:30",
    duration: "5m 12s",
    app: "Google Chrome",
    window: "Stack Overflow - How to fix EADDRINUSE",
    type: "productive",
    icon: Monitor,
    category: "Research",
  },
  {
    id: "3",
    time: "09:39:15",
    duration: "0m 30s",
    app: "Screenshot",
    window: "Desktop Screenshot",
    type: "media",
    icon: Monitor,
    category: "System",
    hasImage: true,
  },
  {
    id: "4",
    time: "09:35:00",
    duration: "4m 15s",
    app: "MS Teams",
    window: "Chat with Project Manager",
    type: "neutral",
    icon: Monitor,
    category: "Communication",
  },
  {
    id: "5",
    time: "09:20:00",
    duration: "15m 0s",
    app: "Idle",
    window: "No active window",
    type: "idle",
    icon: Clock,
    category: "Break",
  },
  {
    id: "6",
    time: "09:05:00",
    duration: "15m 0s",
    app: "VS Code",
    window: "src/index.ts",
    type: "productive",
    icon: Monitor,
    category: "Development",
  },
  {
    id: "7",
    time: "08:54:30",
    duration: "10m 30s",
    app: "Slack",
    window: "#general",
    type: "neutral",
    icon: Monitor,
    category: "Communication",
  },
];

export function Preview() {
  return (
    <div className="min-h-screen bg-slate-50/50 dark:bg-slate-900 p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-white">Activity Timeline</h1>
          <p className="text-slate-500 dark:text-slate-400">Detailed chronological log for **DELL-68** (Hassan Raza)</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" className="bg-white dark:bg-slate-800">
            <CalendarIcon className="mr-2 h-4 w-4" /> May 13, 2026
          </Button>
          <Button variant="outline" className="bg-white dark:bg-slate-800">
            <Filter className="mr-2 h-4 w-4" /> Filter
          </Button>
          <Button className="bg-indigo-600 hover:bg-indigo-700 text-white">
            Export Log
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
              placeholder="Search window titles..."
              className="pl-8 bg-slate-50 dark:bg-slate-700 border-none"
            />
          </div>
          <div className="flex gap-2 items-center text-sm text-slate-500">
            <span>Show:</span>
            <Badge variant="secondary" className="cursor-pointer">All</Badge>
            <Badge variant="outline" className="cursor-pointer hover:bg-slate-100">Productive</Badge>
            <Badge variant="outline" className="cursor-pointer hover:bg-slate-100">Idle</Badge>
            <Badge variant="outline" className="cursor-pointer hover:bg-slate-100">Media</Badge>
          </div>
        </CardContent>
      </Card>

      {/* Timeline List */}
      <div className="space-y-4">
        {timelineEvents.map((event, index) => (
          <div key={event.id} className="relative">
            {/* Timeline Line connecting items */}
            {index !== timelineEvents.length - 1 && (
              <div className="absolute left-6 top-12 bottom-0 w-0.5 bg-slate-100 dark:bg-slate-700" />
            )}
            
            <div className="flex gap-4 items-start">
              {/* Timeline dot/icon */}
              <div className={`relative z-10 flex items-center justify-center w-12 h-12 rounded-full border-4 border-white dark:border-slate-900 ${
                event.type === "productive" ? "bg-emerald-50 text-emerald-500" :
                event.type === "neutral" ? "bg-indigo-50 text-indigo-500" :
                event.type === "idle" ? "bg-amber-50 text-amber-500" :
                "bg-purple-50 text-purple-500"
              }`}>
                {event.type === "idle" ? <Clock className="h-5 w-5" /> : <Monitor className="h-5 w-5" />}
              </div>

              {/* Event Card */}
              <Card className="flex-1 bg-white dark:bg-slate-800 border-none shadow-sm hover:shadow-md transition-shadow">
                <CardContent className="p-4">
                  <div className="flex flex-col md:flex-row justify-between gap-2">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-slate-900 dark:text-white">{event.app}</h3>
                        <Badge variant="outline" className={`text-xs ${
                          event.type === "productive" ? "text-emerald-500 border-emerald-200 bg-emerald-50" :
                          event.type === "neutral" ? "text-indigo-500 border-indigo-200 bg-indigo-50" :
                          event.type === "idle" ? "text-amber-500 border-amber-200 bg-amber-50" :
                          "text-purple-500 border-purple-200 bg-purple-50"
                        }`}>
                          {event.category}
                        </Badge>
                      </div>
                      <p className="text-sm text-slate-600 dark:text-slate-300 flex items-center gap-1">
                        <Info className="h-3.5 w-3.5 text-slate-400" />
                        {event.window}
                      </p>
                    </div>
                    <div className="flex md:flex-col items-start md:items-end justify-between md:justify-center text-xs text-slate-500 gap-1">
                      <span className="font-medium text-slate-700 dark:text-slate-300">{event.time}</span>
                      <span>Duration: {event.duration}</span>
                    </div>
                  </div>

                  {/* Optional Image for Screenshots */}
                  {event.hasImage && (
                    <div className="mt-3">
                      <div className="w-full md:w-[400px] h-[200px] bg-slate-100 dark:bg-slate-700 rounded-lg flex items-center justify-center border-2 border-dashed border-slate-200 dark:border-slate-600">
                        <div className="text-center text-slate-400">
                          <Monitor className="h-8 w-8 mx-auto mb-2 opacity-50" />
                          <p className="text-xs">Encrypted Screenshot</p>
                          <p className="text-[10px]">Click to decrypt and view</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Input Metrics for Active Apps */}
                  {event.type === "productive" && (
                    <div className="mt-3 pt-3 border-t border-slate-50 dark:border-slate-700 flex gap-4 text-xs text-slate-500">
                      <span className="flex items-center gap-1">
                        <MousePointer className="h-3 w-3" /> Active
                      </span>
                      <span className="flex items-center gap-1">
                        <Keyboard className="h-3 w-3" /> 45 WPM
                      </span>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default Preview;
