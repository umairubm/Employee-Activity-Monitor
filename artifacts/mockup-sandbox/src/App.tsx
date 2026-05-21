import * as React from "react";
import { AppProvider, useAppStore } from "./store";
import { Sidebar, type Page } from "./components/Sidebar";
import Dashboard from "./components/pages/Dashboard";
import Timeline from "./components/pages/Timeline";
import Screenshots from "./components/pages/Screenshots";
import Devices from "./components/pages/Devices";
import Attendance from "./components/pages/Attendance";
import Settings from "./components/pages/Settings";

function LoadingScreen() {
  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center">
      <div className="text-center space-y-4">
        <div className="w-12 h-12 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-slate-400 text-sm">Connecting to local server…</p>
      </div>
    </div>
  );
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-6">
      <div className="text-center space-y-4 max-w-md">
        <div className="w-12 h-12 bg-red-500/20 rounded-full flex items-center justify-center mx-auto">
          <span className="text-red-400 text-2xl">⚠</span>
        </div>
        <h2 className="text-white font-semibold text-lg">Cannot reach local server</h2>
        <p className="text-slate-400 text-sm">{message}</p>
        <div className="bg-slate-800 rounded-lg p-4 text-left text-xs font-mono text-slate-300 space-y-1">
          <p className="text-slate-500"># Open a new terminal and run:</p>
          <p className="text-indigo-400">cd D:\Employee_monitor\artifacts\api-server</p>
          <p className="text-emerald-400">$env:PORT="5000"; node ./local-server.mjs</p>
        </div>
        <button
          onClick={onRetry}
          className="bg-indigo-600 hover:bg-indigo-700 text-white text-sm px-5 py-2.5 rounded-lg font-medium transition-colors"
        >
          Retry Connection
        </button>
      </div>
    </div>
  );
}

function AppShell() {
  const [currentPage, setCurrentPage] = React.useState<Page>("dashboard");
  const { loading, error, refresh } = useAppStore();

  if (loading) return <LoadingScreen />;
  if (error) return <ErrorScreen message={error} onRetry={refresh} />;

  const renderPage = () => {
    switch (currentPage) {
      case "dashboard": return <Dashboard onNavigate={setCurrentPage} />;
      case "timeline": return <Timeline />;
      case "attendance": return <Attendance />;
      case "screenshots": return <Screenshots />;
      case "devices": return <Devices onNavigate={setCurrentPage} />;
      case "settings": return <Settings />;
      default: return <Dashboard onNavigate={setCurrentPage} />;
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <Sidebar currentPage={currentPage} onNavigate={setCurrentPage} />
      <main className="ml-64 min-h-screen">
        <div className="p-6 max-w-[1400px]">
          {renderPage()}
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  );
}
