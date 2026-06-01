import React, { useState } from "react";
import { useListScreenshots, getListScreenshotsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { format } from "date-fns";
import { Image as ImageIcon, Info, Search } from "lucide-react";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";

export default function Screenshots() {
  const { data: screenshots, isLoading } = useListScreenshots({ limit: 50 }, { query: { queryKey: getListScreenshotsQueryKey({ limit: 50 }) } });

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Screenshots</h1>
          <p className="text-muted-foreground mt-1">Periodic captures taken with explicit user consent.</p>
        </div>
      </div>

      <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 flex gap-3 text-sm text-primary">
        <Info className="h-5 w-5 flex-shrink-0 mt-0.5" />
        <p>
          <strong>Transparency Notice:</strong> All screenshots are captured only while monitoring is actively enabled, 
          and users are notified via the system tray icon when captures occur.
        </p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 animate-pulse">
          {[1, 2, 3, 4, 5, 6, 7, 8].map(i => (
            <div key={i} className="aspect-video bg-muted rounded-xl"></div>
          ))}
        </div>
      ) : screenshots?.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center h-64 text-muted-foreground">
            <ImageIcon className="h-10 w-10 mb-4 opacity-20" />
            <p>No screenshots have been captured yet.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {screenshots?.map(screenshot => (
            <Dialog key={screenshot.id}>
              <DialogTrigger asChild>
                <div className="group cursor-pointer rounded-xl overflow-hidden border border-border bg-card shadow-sm hover:shadow-md transition-all">
                  <div className="aspect-video bg-secondary relative overflow-hidden">
                    <img 
                      src={screenshot.imageUrl} 
                      alt="Screenshot" 
                      className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                      loading="lazy"
                    />
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors"></div>
                  </div>
                  <div className="p-3 bg-card border-t border-border">
                    <p className="text-sm font-medium">{format(new Date(screenshot.capturedAt), "MMM d, yyyy")}</p>
                    <p className="text-xs text-muted-foreground mt-1">{format(new Date(screenshot.capturedAt), "h:mm:ss a")}</p>
                  </div>
                </div>
              </DialogTrigger>
              <DialogContent className="max-w-5xl p-1 bg-black/95 border-none shadow-2xl">
                <div className="relative">
                  <img 
                    src={screenshot.imageUrl} 
                    alt="Screenshot full size" 
                    className="w-full h-auto max-h-[85vh] object-contain rounded-md"
                  />
                  <div className="absolute bottom-4 left-4 bg-black/70 backdrop-blur-md text-white px-3 py-1.5 rounded-md text-sm border border-white/10">
                    {format(new Date(screenshot.capturedAt), "PPpp")}
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          ))}
        </div>
      )}
    </div>
  );
}
