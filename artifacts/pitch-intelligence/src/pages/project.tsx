import { useState, useRef, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { 
  useGetProject, 
  getGetProjectQueryKey,
  useGetProjectWorkspace, 
  getGetProjectWorkspaceQueryKey,
  useGetProjectConversation,
  getGetProjectConversationQueryKey,
  useSendProjectMessage,
  useGetProjectIntelligence,
  getGetProjectIntelligenceQueryKey
} from "@workspace/api-client-react";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { 
  Compass, 
  Lightbulb, 
  Crosshair, 
  Megaphone, 
  Map, 
  Image as ImageIcon, 
  Presentation,
  Send,
  Sparkles,
  ChevronRight,
  ArrowLeft,
  MessageSquare,
  AlertCircle,
  Database
} from "lucide-react";

import { OverviewTab } from "./tabs/overview";
import { IntelligenceTab } from "./tabs/intelligence";
import { CompetitorsTab } from "./tabs/competitors";
import { CampaignsTab } from "./tabs/campaigns";
import { StrategyTab } from "./tabs/strategy";
import { LocationsTab } from "./tabs/locations";
import { InventoryTab } from "./tabs/inventory";
import { StagedTab } from "./tabs/staged";

const TABS = [
  { id: "overview", label: "Pitch Recommendation", icon: Compass, group: "Pitch workspace" },
  { id: "locations", label: "Map & Locations", icon: Map, group: "Pitch workspace" },
  { id: "inventory", label: "Review Assets", icon: Database, group: "Pitch workspace" },
  { id: "mockups", label: "Mockups", icon: ImageIcon, group: "Pitch workspace" },
  { id: "deck", label: "Proposal", icon: Presentation, group: "Pitch workspace" },
  { id: "intelligence", label: "Intelligence", icon: Lightbulb, group: "Deep Research" },
  { id: "competitors", label: "Competitors", icon: Crosshair, group: "Deep Research" },
  { id: "campaigns", label: "Campaigns", icon: Megaphone, group: "Deep Research" },
  { id: "strategy", label: "Strategy", icon: Compass, group: "Deep Research" },
];

export default function ProjectWorkspace() {
  const params = useParams();
  const [, setLocation] = useLocation();
  const projectId = params?.id || "";
  const currentTab = params?.tab || "overview";

  const { data: project, isLoading: isLoadingProject, isError: isErrorProject } = useGetProject(projectId, {
    query: { enabled: !!projectId, queryKey: getGetProjectQueryKey(projectId) }
  });
  
  const { data: workspace, isLoading: isLoadingWorkspace, isError: isWorkspaceError, refetch: retryWorkspace } = useGetProjectWorkspace(projectId, {
    query: { enabled: !!projectId, queryKey: getGetProjectWorkspaceQueryKey(projectId) }
  });
  
  const [copilotOpen, setCopilotOpen] = useState(false);

  if (isErrorProject) {
    return (
      <div className="min-h-[100dvh] flex flex-col bg-slate-50 dark:bg-slate-950">
        <Header />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center p-8 bg-white dark:bg-slate-900 rounded-xl shadow-sm border max-w-md">
            <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
            <h2 className="text-xl font-semibold mb-2">Project not found</h2>
            <p className="text-muted-foreground mb-6">The workspace you're looking for doesn't exist or you don't have access.</p>
            <Button onClick={() => setLocation("/")} variant="outline">
              <ArrowLeft className="h-4 w-4 mr-2" /> Return to Dashboard
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] flex flex-col bg-slate-50 dark:bg-slate-950 overflow-hidden">
      <Header />
      
      {/* Project Sub-header */}
      <div className="bg-white dark:bg-slate-900 border-b px-4 py-3 shrink-0 flex items-center min-w-0">
        <div className="mx-auto flex w-full max-w-[1800px] items-center min-w-0 px-2 xl:px-4">
          <Button variant="ghost" size="sm" onClick={() => setLocation("/")} className="mr-2 sm:mr-4 -ml-2 text-muted-foreground shrink-0">
            <ArrowLeft className="h-4 w-4 sm:mr-1" /> <span className="hidden sm:inline">Dashboard</span>
          </Button>
          <Separator orientation="vertical" className="h-6 mr-2 sm:mr-4 shrink-0" />
          {isLoadingProject ? (
            <Skeleton className="h-6 w-48" />
          ) : (
            <div className="flex items-center min-w-0">
              <h2 className="font-semibold text-lg mr-2 truncate shrink-0 max-w-[100px] sm:max-w-[160px]">{project?.clientName}</h2>
              <span className="text-muted-foreground text-sm flex items-center min-w-0">
                <ChevronRight className="h-3 w-3 mx-1 shrink-0" />
                <span className="truncate">{project?.title}</span>
              </span>
              {project?.isDemo && (
                <Badge variant="outline" className="hidden sm:inline-flex ml-4 text-xs border-dashed shrink-0">Sample Data</Badge>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Main Workspace Layout */}
      <div className="relative mx-auto flex w-full max-w-[1800px] flex-1 flex-col overflow-hidden xl:flex-row">
        
        {/* Mobile Navigation */}
        <div className="shrink-0 overflow-x-auto border-b bg-slate-50/50 dark:bg-slate-950/50 no-scrollbar xl:hidden">
          <nav className="flex px-4 py-2 gap-2" aria-label="Project sections">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = currentTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setLocation(`/projects/${projectId}/${tab.id}`)}
                  className={`flex flex-nowrap whitespace-nowrap items-center px-3 py-2 rounded-md text-sm font-medium transition-colors shrink-0 ${
                    isActive 
                      ? 'bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-white' 
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/50 hover:text-slate-900 dark:hover:text-white'
                  }`}
                  data-testid={`tab-mobile-${tab.id}`}
                >
                  <Icon className={`h-4 w-4 mr-2 ${isActive ? 'text-brand' : 'opacity-70'}`} />
                  {tab.group === "Deep Research" && tab.id === "intelligence" && <span className="mr-2 text-[10px] uppercase tracking-wider text-muted-foreground">Deep research /</span>}{tab.label}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Desktop Sidebar - Navigation */}
        <aside className="hidden w-52 shrink-0 flex-col overflow-y-auto border-r bg-slate-50/50 py-6 dark:bg-slate-950/50 xl:flex">
          <nav className="space-y-1 px-3" aria-label="Project sections">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = currentTab === tab.id;
              return (<div key={tab.id}>
                {(tab.id === "overview" || tab.id === "intelligence") && <p className={`px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground ${tab.id === "intelligence" ? "pt-8" : "pt-1"}`}>{tab.group}</p>}
                <button
                  onClick={() => setLocation(`/projects/${projectId}/${tab.id}`)}
                  aria-current={isActive ? "page" : undefined}
                  className={`w-full flex items-center px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                    isActive 
                      ? 'bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-white' 
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/50 hover:text-slate-900 dark:hover:text-white'
                  }`}
                  data-testid={`tab-${tab.id}`}
                >
                  <Icon className={`h-4 w-4 mr-3 ${isActive ? 'text-brand' : 'opacity-70'}`} />
                  {tab.label}
                </button>
              </div>);
            })}
          </nav>
        </aside>

        {/* Center - Main Content */}
        <main className="flex-1 flex flex-col bg-white dark:bg-slate-900 overflow-hidden relative min-w-0">
          <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
            <div className="p-4 md:p-8 w-full min-w-0">
              {isLoadingWorkspace ? (
                <div className="space-y-6 animate-pulse">
                  <div className="h-8 bg-slate-100 rounded w-1/3 mb-8"></div>
                  <div className="h-64 bg-slate-100 rounded-xl w-full"></div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="h-48 bg-slate-100 rounded-xl"></div>
                    <div className="h-48 bg-slate-100 rounded-xl"></div>
                  </div>
                </div>
               ) : isWorkspaceError && currentTab === "overview" ? (
                 <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center">
                   <AlertCircle className="h-8 w-8 text-destructive mx-auto mb-3" />
                   <h2 className="font-semibold mb-2">Pitch brief unavailable</h2>
                   <p className="text-sm text-muted-foreground mb-4">We could not load this workspace right now.</p>
                   <Button variant="outline" onClick={() => retryWorkspace()} data-testid="button-retry-workspace">Try again</Button>
                 </div>
               ) : currentTab === "overview" && workspace ? (
                <OverviewTab workspace={workspace} />
              ) : currentTab === "intelligence" ? (
                <IntelligenceTab />
              ) : currentTab === "competitors" ? (
                <CompetitorsTab />
              ) : currentTab === "campaigns" ? (
                <CampaignsTab />
              ) : currentTab === "strategy" ? (
                <StrategyTab />
              ) : currentTab === "inventory" ? (
                <InventoryTab />
              ) : currentTab === "locations" ? (
                <LocationsTab />
              ) : (
                <StagedTab tabId={currentTab} tabName={TABS.find(t => t.id === currentTab)?.label || currentTab} />
              )}
            </div>
          </div>
          
          {/* Floating Mobile Copilot Toggle */}
          <div className="absolute bottom-6 right-6 z-30 xl:hidden">
            <Button 
              size="lg" 
              className="rounded-full shadow-xl bg-brand text-brand-foreground hover:bg-brand/90 h-14 px-6 flex items-center gap-2"
              onClick={() => setCopilotOpen(true)}
            >
              <Sparkles className="h-5 w-5" />
              <span>Ask Copilot</span>
            </Button>
          </div>
        </main>

        {/* Right Sidebar - Copilot Panel */}
        <CopilotPanel projectId={projectId} isOpen={copilotOpen} onClose={() => setCopilotOpen(false)} />

      </div>
    </div>
  );
}

function CopilotPanel({ projectId, isOpen, onClose }: { projectId: string, isOpen?: boolean, onClose?: () => void }) {
  const queryClient = useQueryClient();
  const {
    data: conversation,
    isLoading,
    isError: isConversationError,
    error: conversationError,
  } = useGetProjectConversation(projectId, {
    query: { enabled: !!projectId, queryKey: getGetProjectConversationQueryKey(projectId) }
  });
  
  const { data: intelligence } = useGetProjectIntelligence(projectId, {
    query: { enabled: !!projectId, queryKey: getGetProjectIntelligenceQueryKey(projectId) }
  });
  const liveResearchAvailable = intelligence?.status?.liveResearchAvailable;
  
  const sendMessage = useSendProjectMessage();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [conversation?.messages]);

  const handleSend = () => {
    if (!input.trim() || sendMessage.isPending) return;
    
    sendMessage.mutate({
      id: projectId,
      data: { content: input }
    }, {
      onSuccess: () => {
        setInput("");
        queryClient.invalidateQueries({ queryKey: getGetProjectConversationQueryKey(projectId) });
      }
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <>
      {isOpen && (
        <div 
          className="fixed inset-0 z-40 bg-black/50 transition-opacity xl:hidden"
          onClick={onClose} 
          aria-hidden="true" 
        />
      )}
      <aside className={`
        fixed inset-y-0 right-0 z-50 transform transition-transform duration-300 ease-in-out
        w-[85vw] sm:w-[380px] xl:static xl:z-10 xl:w-80 xl:shrink-0 xl:transform-none 2xl:w-[340px]
        border-l bg-slate-50/95 backdrop-blur-sm dark:bg-slate-950/95 xl:bg-slate-50/80 xl:dark:bg-slate-950/80
        flex flex-col shadow-2xl xl:shadow-[-4px_0_15px_-5px_rgba(0,0,0,0.05)]
        ${isOpen ? 'translate-x-0' : 'translate-x-full xl:translate-x-0'}
      `}>
        <div className="h-14 border-b flex items-center justify-between px-4 bg-white dark:bg-slate-900 shrink-0">
          <div className="flex items-center">
            <Sparkles className="h-4 w-4 text-brand mr-2" />
            <h3 className="font-semibold text-sm">Project Copilot</h3>
          </div>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground xl:hidden" onClick={onClose}>
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            <span className="sr-only">Close</span>
          </Button>
        </div>
      
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4" ref={scrollRef}>
        {!liveResearchAvailable && (
          <div
            className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300"
            data-testid="notice-copilot-placeholder-mode"
          >
            <p className="font-medium">Project context mode — live AI and research not connected</p>
            <p className="mt-1 opacity-80">Stored deterministic replies are contextual, but responses are placeholders.</p>
          </div>
        )}

        {isLoading ? (
          <div className="flex flex-col gap-4">
            <div className="flex gap-3">
              <Skeleton className="h-8 w-8 rounded-full shrink-0" />
              <Skeleton className="h-20 w-3/4 rounded-2xl rounded-tl-sm" />
            </div>
            <div className="flex gap-3 flex-row-reverse">
              <Skeleton className="h-8 w-8 rounded-full shrink-0" />
              <Skeleton className="h-12 w-2/3 rounded-2xl rounded-tr-sm" />
            </div>
          </div>
        ) : isConversationError ? (
          <div
            className="flex flex-1 flex-col items-center justify-center rounded-lg border border-destructive/20 bg-destructive/5 p-6 text-center text-destructive"
            data-testid="error-copilot-load"
          >
            <AlertCircle className="mb-3 h-8 w-8 opacity-80" />
            <p className="text-sm font-medium">Conversation unavailable</p>
            <p className="mt-1 text-xs opacity-80">
              {conversationError instanceof Error ? conversationError.message : "Saved messages could not be loaded."}
            </p>
          </div>
        ) : !conversation || conversation.messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-muted-foreground">
            <MessageSquare className="h-10 w-10 mb-4 opacity-20" />
            <p className="text-sm">
              {liveResearchAvailable
                ? "No conversation yet. Ask about sourced brand research once evidence is available."
                : "Saved messages will appear here. Live AI research is not connected."}
            </p>
          </div>
        ) : (
          conversation?.messages.map((msg) => (
            <div 
              key={msg.id} 
              className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
            >
              <Avatar className="h-8 w-8 shrink-0 border border-slate-200 dark:border-slate-800">
                {msg.role === 'assistant' ? (
                  <div className="bg-brand text-white w-full h-full flex items-center justify-center">
                    <Sparkles className="h-4 w-4" />
                  </div>
                ) : (
                  <AvatarFallback className="bg-slate-200 dark:bg-slate-800 text-xs">U</AvatarFallback>
                )}
              </Avatar>
              <div 
                className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} flex-1 min-w-0`}
              >
                <div 
                  className={`px-4 py-2.5 rounded-2xl text-sm max-w-full ${
                    msg.role === 'user' 
                      ? 'bg-slate-900 text-white dark:bg-slate-200 dark:text-slate-900 rounded-tr-sm' 
                      : 'bg-white dark:bg-slate-900 border rounded-tl-sm shadow-sm'
                  }`}
                >
                  <p className="whitespace-pre-wrap leading-relaxed break-words [overflow-wrap:anywhere]">{msg.content}</p>
                </div>
                {msg.isPlaceholder && msg.role === 'assistant' && (
                  <span className="text-[10px] text-muted-foreground mt-1 mx-1 italic">
                    Placeholder response
                  </span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="p-4 bg-white dark:bg-slate-900 border-t shrink-0">
        {sendMessage.isError && (
          <div
            className="mb-3 flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            data-testid="error-copilot-send"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Message could not be saved. {sendMessage.error instanceof Error ? sendMessage.error.message : "Please try again."}
            </span>
          </div>
        )}
        <div className="relative">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about strategy, locations..."
            className="min-h-[80px] pr-12 resize-none bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 focus-visible:ring-brand text-base md:text-sm"
            data-testid="input-copilot"
          />
          <Button 
            size="icon" 
            className="absolute bottom-2 right-2 h-8 w-8 rounded-full bg-brand text-brand-foreground hover:bg-brand/90"
            disabled={!input.trim() || sendMessage.isPending}
            onClick={handleSend}
            data-testid="button-send-copilot"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-[10px] text-center text-muted-foreground mt-2">
          Copilot can make mistakes. Verify critical data.
        </p>
      </div>
    </aside>
    </>
  );
}
