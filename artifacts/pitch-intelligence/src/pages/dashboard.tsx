import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useGetDashboard, useListProjects, useCreateProject, type ProjectInputPitchObjective, type ProjectInputPreferredMedia, type ProjectInput } from "@workspace/api-client-react";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Briefcase, ArrowRight, AlertCircle, Compass, Sparkles, Lightbulb, MapPin, ImageIcon } from "lucide-react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { BrandPicker, type BrandOption } from "@/components/brand-picker";

const objectives = ["Store / Branch Footfall", "Product Launch", "Brand Awareness", "Seasonal Campaign", "Specific Area Coverage", "Competitor Response", "General OOH Proposal"] as const;
const campaignGeographies = ["DUBAI", "ABU_DHABI", "UAE", "CUSTOM"] as const;
type CampaignGeography = typeof campaignGeographies[number];
type CampaignGeographyInput = { campaignGeography: CampaignGeography; campaignAreas: string[] };
const geographyLabel = (geography: CampaignGeography | undefined, areas: string[] | undefined) =>
  geography === "CUSTOM" ? (areas?.join(", ") || "Custom areas") : ({ DUBAI: "Dubai", ABU_DHABI: "Abu Dhabi", UAE: "UAE" } as const)[geography || "DUBAI"];
const parseCampaignAreas = (value: string) => [...new Set(value.split(/[,\n]/).map(area => area.trim()).filter(Boolean))];
const createProjectSchema = z.object({
  clientName: z.string().min(1, "Client name is required").max(120),
  market: z.string().min(1, "Brand Market is required").max(120),
  category: z.string().max(120).optional(),
  pitchObjective: z.enum(objectives, { required_error: "Choose one pitch objective" }),
  preferredMedia: z.enum(["bus", "bus_shelter", "both"], { required_error: "Choose a media preference" }),
  targetQuantity: z.union([z.literal(""), z.coerce.number().int().min(1, "Enter at least 1").max(1000)]),
  productFocus: z.string().max(180).optional(),
  campaignGeography: z.enum(campaignGeographies),
  campaignAreas: z.string().max(1000).optional(),
}).superRefine((value, context) => {
  if (value.campaignGeography === "CUSTOM") {
    const areas = parseCampaignAreas(value.campaignAreas || "");
    if (!areas.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["campaignAreas"], message: "Add at least one campaign area" });
    areas.forEach(area => {
      if (area.length < 2 || area.length > 80) context.addIssue({ code: z.ZodIssueCode.custom, path: ["campaignAreas"], message: "Each area must be between 2 and 80 characters" });
    });
  }
});

export default function Dashboard() {
  const { data: dashboard, isLoading: isLoadingDashboard, isError: isErrorDashboard } = useGetDashboard();
  const { data: projects, isLoading: isLoadingProjects } = useListProjects();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [selectedBrand, setSelectedBrand] = useState<BrandOption | null>(null);
  const [enteredName, setEnteredName] = useState("");
  const [, setLocation] = useLocation();
  
  return (
    <div className="min-h-[100dvh] flex flex-col bg-slate-50 dark:bg-slate-950">
      <Header />
      
      <main className="flex-1 container mx-auto px-4 pb-16 max-w-6xl">
        {/* Hero Section */}
        <div className="relative overflow-hidden rounded-b-[2rem] bg-slate-900 px-5 py-16 md:py-24 text-center text-slate-50 mb-12">
          <div className="absolute inset-0 opacity-20 pointer-events-none" style={{backgroundImage:"radial-gradient(circle at 82% 20%, #6b91a4, transparent 33%), linear-gradient(130deg, transparent 45%, #7795a6 46%, transparent 47%)"}} />
          <div className="relative flex flex-col items-center">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-cyan-200 mb-6">New business / Pitch planning</p>
          <h1 className="text-4xl md:text-6xl font-semibold tracking-tight max-w-3xl leading-[1.08] mb-5">
            What exactly are we pitching?
          </h1>
          <p className="text-slate-300 max-w-xl mb-9 text-sm md:text-base">Start with the right client and focus. Then turn verified signals and real network options into a proposal worth presenting.</p>
          <BrandPicker onSelect={(option, name) => {
            setSelectedBrand(option);
            setEnteredName(name);
            setIsCreateOpen(true);
          }} />
          </div>
        </div>

        <CreateProjectDialog 
          open={isCreateOpen} 
          onOpenChange={setIsCreateOpen} 
          selectedBrand={selectedBrand}
          enteredName={enteredName}
          onSuccess={(id) => {
            setIsCreateOpen(false);
            setLocation(`/projects/${id}/overview`);
          }}
        />

        {isErrorDashboard ? (
          <div className="bg-destructive/10 text-destructive p-6 rounded-lg flex flex-col items-center justify-center text-center mb-16">
            <AlertCircle className="h-10 w-10 mb-4 opacity-80" />
            <h3 className="text-lg font-medium mb-1">Failed to load dashboard</h3>
            <p className="opacity-80">There was a problem loading your workspace. Please try refreshing.</p>
          </div>
        ) : (
          <>
            {/* Summary Row */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-16">
              <SummaryCard 
                 title="Active pitches"
                value={dashboard?.activeProjectCount ?? 0} 
                icon={<Briefcase className="h-5 w-5 text-brand" />}
                isLoading={isLoadingDashboard}
              />
              <SummaryCard 
                 title="Research in progress"
                value={dashboard?.researchInProgressCount ?? 0} 
                icon={<Compass className="h-5 w-5 text-blue-500" />}
                isLoading={isLoadingDashboard}
              />
              <SummaryCard 
                 title="Pitch ready"
                value={dashboard?.pitchReadyCount ?? 0} 
                icon={<Sparkles className="h-5 w-5 text-emerald-500" />}
                isLoading={isLoadingDashboard}
              />
            </div>

            {/* Recent Projects */}
            <div className="mb-16">
              <div className="mb-6 flex items-center justify-between">
                <h2 className="text-2xl font-semibold tracking-tight">Your pitches</h2>
              </div>
              
              {isLoadingProjects ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {[1, 2, 3].map(i => <ProjectCardSkeleton key={i} />)}
                </div>
              ) : projects && projects.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {projects.map(project => (
                    <ProjectCard key={project.id} project={project} />
                  ))}
                </div>
              ) : (
                <div className="bg-white dark:bg-slate-900 border rounded-xl p-12 text-center flex flex-col items-center justify-center shadow-sm">
                  <div className="bg-slate-100 dark:bg-slate-800 p-4 rounded-full mb-4">
                    <Compass className="h-8 w-8 text-slate-400" />
                  </div>
                  <h3 className="text-xl font-medium mb-2">No projects yet</h3>
                  <p className="text-muted-foreground mb-6 max-w-md">
                     Search for a client above to open your first pitch workspace.
                  </p>
                </div>
              )}
            </div>

            {/* Capabilities */}
            <div>
              <div className="mb-6">
                 <h2 className="text-2xl font-semibold tracking-tight">From brief to proposal</h2>
                 <p className="text-muted-foreground">A practical path through your workspace. Evidence supports the recommendation, not the other way around.</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <CapabilityCard 
                   title="Find the angle"
                   description="Review sourced client signals and clarify what the pitch needs to accomplish."
                  icon={<Lightbulb className="h-6 w-6 text-brand" />}
                />
                <CapabilityCard 
                   title="Plan the network"
                   description="Compare approved store coverage, route options, and available asset records before committing to a direction."
                  icon={<MapPin className="h-6 w-6 text-blue-600" />}
                />
                <CapabilityCard 
                   title="Present the idea"
                   description="Carry your planning into the staged mockups and proposal tabs. No creative is generated automatically."
                  icon={<ImageIcon className="h-6 w-6 text-emerald-600" />}
                />
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function CapabilityCard({ title, description, icon }: { title: string, description: string, icon: React.ReactNode }) {
  return (
    <Card className="shadow-sm border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
      <CardHeader className="pb-3">
        <div className="bg-white dark:bg-slate-800 w-12 h-12 rounded-xl shadow-sm flex items-center justify-center mb-4">
          {icon}
        </div>
        <CardTitle className="text-lg">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
      </CardContent>
    </Card>
  );
}

function SummaryCard({ title, value, description, icon, isLoading }: { title: string, value: number | string, description?: string, icon: React.ReactNode, isLoading: boolean }) {
  return (
    <Card className="shadow-sm border-slate-200 dark:border-slate-800">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-16 mb-1" />
        ) : (
          <div className="text-3xl font-bold">{value}</div>
        )}
        {description && (
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        )}
      </CardContent>
    </Card>
  );
}

function ProjectCard({ project }: { project: any }) {
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active': return 'success';
      case 'on_hold': return 'warning';
      case 'completed': return 'default';
      default: return 'secondary';
    }
  };

  return (
    <Card className="group hover:border-slate-300 dark:hover:border-slate-700 transition-colors shadow-sm h-full flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex justify-between items-start mb-2">
          <Badge variant={getStatusColor(project.status) as any} className="capitalize" data-testid={`badge-status-${project.id}`}>
            {project.status.replace('_', ' ')}
          </Badge>
          {project.isDemo && (
            <Badge variant="outline" className="text-xs border-dashed text-slate-500">Sample Data</Badge>
          )}
        </div>
        <CardTitle className="text-xl line-clamp-1 group-hover:text-brand transition-colors" data-testid={`text-project-title-${project.id}`}>
          {project.clientName}
        </CardTitle>
        <CardDescription className="line-clamp-1">{project.title}</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 pb-4">
        <div className="space-y-2 text-sm">
          <div className="flex justify-between border-b pb-2">
            <span className="text-muted-foreground">Brand Market</span>
            <span className="font-medium text-foreground">{project.market}</span>
          </div>
          <div className="flex justify-between border-b pb-2">
            <span className="text-muted-foreground">Campaign geography</span>
            <span className="font-medium text-foreground text-right">{geographyLabel((project as typeof project & { campaignGeography?: CampaignGeography }).campaignGeography, (project as typeof project & { campaignAreas?: string[] }).campaignAreas)}</span>
          </div>
          <div className="flex justify-between border-b pb-2">
            <span className="text-muted-foreground">Category</span>
            <span className="font-medium text-foreground">{project.category || '—'}</span>
          </div>
          <div className="flex justify-between pt-1">
            <span className="text-muted-foreground">Stage</span>
            <span className="font-medium text-foreground capitalize">{project.stage}</span>
          </div>
        </div>
      </CardContent>
      <CardFooter className="pt-0">
        <Link href={`/projects/${project.id}/overview`} className="w-full" data-testid={`link-project-${project.id}`}>
          <div className="inline-flex h-10 px-4 py-2 items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 border border-input bg-background hover:bg-accent hover:text-accent-foreground w-full group-hover:bg-slate-50 dark:group-hover:bg-slate-800">
            Open Workspace
            <ArrowRight className="h-4 w-4 ml-2 opacity-50 group-hover:opacity-100 transition-opacity" />
          </div>
        </Link>
      </CardFooter>
    </Card>
  );
}

function ProjectCardSkeleton() {
  return (
    <Card className="h-full flex flex-col shadow-sm">
      <CardHeader className="pb-3">
        <Skeleton className="h-5 w-16 mb-2" />
        <Skeleton className="h-6 w-3/4 mb-1" />
        <Skeleton className="h-4 w-full" />
      </CardHeader>
      <CardContent className="flex-1">
        <div className="space-y-4">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      </CardContent>
      <CardFooter>
        <Skeleton className="h-10 w-full" />
      </CardFooter>
    </Card>
  );
}

function CreateProjectDialog({ open, onOpenChange, onSuccess, selectedBrand, enteredName }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: (id: string) => void;
  selectedBrand: BrandOption | null;
  enteredName: string;
}) {
  const { toast } = useToast();
  const createProject = useCreateProject();
  
  const form = useForm<z.infer<typeof createProjectSchema>>({
    resolver: zodResolver(createProjectSchema),
    defaultValues: {
      clientName: "",
      market: "",
      category: "",
      pitchObjective: undefined,
       preferredMedia: undefined,
      targetQuantity: "",
      productFocus: "",
      campaignGeography: "DUBAI",
      campaignAreas: "",
    },
  });
  const { reset } = form;

  useEffect(() => {
    if (!open) return;
    reset({
      clientName: selectedBrand?.kind === "category"
        ? selectedBrand.parent ?? enteredName
        : selectedBrand?.name ?? enteredName,
      market: "",
      category: selectedBrand?.category ?? (selectedBrand?.kind === "category" ? selectedBrand.name : ""),
      pitchObjective: undefined,
       preferredMedia: undefined,
      targetQuantity: "",
      productFocus: selectedBrand?.kind === "category" ? selectedBrand.name : "",
      campaignGeography: "DUBAI",
      campaignAreas: "",
    });
  }, [open, enteredName, selectedBrand, reset]);

  const onSubmit = (data: z.infer<typeof createProjectSchema>) => {
    createProject.mutate({
      data: {
        clientName: data.clientName,
        market: data.market,
        category: data.category || null,
         pitchObjective: data.pitchObjective as ProjectInputPitchObjective,
        productFocus: data.productFocus || null,
         preferredMedia: data.preferredMedia as ProjectInputPreferredMedia,
         targetQuantity: data.targetQuantity === "" ? null : Number(data.targetQuantity),
         campaignGeography: data.campaignGeography,
         campaignAreas: data.campaignGeography === "CUSTOM" ? parseCampaignAreas(data.campaignAreas || "") : [],
        brandSelectionToken: selectedBrand?.selectionToken,
      } as ProjectInput & CampaignGeographyInput
    }, {
      onSuccess: (project) => {
        toast({
          title: "Project created",
             description: selectedBrand ? "Pitch workspace created. Quick research is starting for your selected focus." : "Workspace created without research. Confirm a brand before starting research.",
        });
        form.reset();
        onSuccess(project.id);
      },
      onError: (error) => {
        if (error.status === 503 && error.data?.projectId) {
          toast({
            title: "Workspace saved, research did not start",
            description: "Open the workspace to retry research. No second project is needed.",
            variant: "destructive",
          });
          onSuccess(error.data.projectId);
          return;
        }
        toast({
          title: "Failed to create project",
          description: String(error).includes("selection") || String(error).includes("expired")
            ? "This suggestion has expired. Search for the brand again before creating the project."
            : "Please try again later.",
          variant: "destructive",
        });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
       <DialogContent className="sm:max-w-[580px] max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
           <DialogTitle>Set the pitch brief</DialogTitle>
          <DialogDescription>
            {selectedBrand
               ? `Review your ${selectedBrand.kind} selection, then set the objective and media direction.`
               : "This is an unverified name. The workspace will be created without automatic research."}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
           <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 py-4">
             {selectedBrand && <div className="rounded-xl border border-brand/20 bg-brand/5 p-4 text-sm space-y-1" data-testid="summary-selected-brand">
               <p className="font-semibold">{selectedBrand.name} <span className="font-normal text-muted-foreground">· {selectedBrand.kind === "company" ? "Whole-company pitch" : selectedBrand.kind}</span></p>
               <p>Parent: {selectedBrand.parent || "None identified"} · Category: {selectedBrand.category || "Not specified"}</p>
                <p>UAE/regional entity: {selectedBrand.regionalEntity
                  ? <a href={selectedBrand.regionalEntity.sourceUrl} target="_blank" rel="noreferrer" title={selectedBrand.regionalEntity.evidenceQuote} className="text-brand underline">{selectedBrand.regionalEntity.name}</a>
                  : "Not independently verified"}</p>
               <p className="break-all">Website: {selectedBrand.website}</p>
               <a href={selectedBrand.sourceUrl} target="_blank" rel="noreferrer" className="text-brand underline" data-testid="link-selection-source">Review cited source</a>
             </div>}
            <FormField
              control={form.control}
              name="clientName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Client / Brand Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Emirates Airlines" {...field} readOnly={!!selectedBrand} data-testid="input-client-name" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="market"
                render={({ field }) => (
                  <FormItem>
                     <FormLabel>Brand Market</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Dubai, UAE" {...field} required aria-required="true" data-testid="input-market" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                     <FormLabel>Category <span className="text-muted-foreground font-normal">(optional)</span></FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Travel" {...field} readOnly={!!selectedBrand && (selectedBrand.kind === "category" || !!selectedBrand.category)} data-testid="input-category" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField control={form.control} name="campaignGeography" render={({ field }) => (
              <FormItem>
                <FormLabel>Campaign Geography</FormLabel>
                <FormControl>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger data-testid="select-campaign-geography"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="DUBAI">Dubai</SelectItem>
                      <SelectItem value="ABU_DHABI">Abu Dhabi</SelectItem>
                      <SelectItem value="UAE">UAE</SelectItem>
                      <SelectItem value="CUSTOM">Custom areas</SelectItem>
                    </SelectContent>
                  </Select>
                </FormControl>
                <FormMessage />
              </FormItem>
            )} />
            {form.watch("campaignGeography") === "CUSTOM" && <FormField control={form.control} name="campaignAreas" render={({ field }) => (
              <FormItem>
                <FormLabel>Custom campaign areas</FormLabel>
                <FormControl><Textarea {...field} rows={3} placeholder="Separate areas with commas or new lines" data-testid="input-campaign-areas" /></FormControl>
                <FormMessage />
              </FormItem>
            )} />}
            <div className="space-y-4">
              <FormField
                control={form.control}
                name="pitchObjective"
                render={({ field }) => (
                  <FormItem>
                     <FormLabel>Pitch objective</FormLabel>
                    <FormControl>
                        <Select onValueChange={field.onChange} value={field.value ?? ""}>
                          <SelectTrigger aria-required="true" data-testid="select-pitch-objective"><SelectValue placeholder="Choose the reason for this pitch" /></SelectTrigger>
                         <SelectContent>{objectives.map(objective => <SelectItem key={objective} value={objective}>{objective}</SelectItem>)}</SelectContent>
                       </Select>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
               <FormField control={form.control} name="preferredMedia" render={({field}) => <FormItem>
                 <FormLabel>Preferred media</FormLabel>
                 <FormControl><Select onValueChange={field.onChange} value={field.value ?? ""}><SelectTrigger aria-required="true" data-testid="select-preferred-media"><SelectValue placeholder="Choose bus, shelter, or both" /></SelectTrigger><SelectContent><SelectItem value="bus">Bus</SelectItem><SelectItem value="bus_shelter">Bus shelter</SelectItem><SelectItem value="both">Both / explore options</SelectItem></SelectContent></Select></FormControl><FormMessage />
               </FormItem>} />
               <FormField control={form.control} name="targetQuantity" render={({field}) => <FormItem>
                 <FormLabel>Campaign quantity <span className="font-normal text-muted-foreground">(optional)</span></FormLabel>
                 <FormControl><Input type="number" min={1} max={1000} step={1} placeholder="Leave open for planning" value={field.value} onChange={field.onChange} data-testid="input-target-quantity" /></FormControl><FormMessage />
               </FormItem>} />
               <FormField
                control={form.control}
                name="productFocus"
                render={({ field }) => (
                  <FormItem>
                     <FormLabel>Product focus <span className="text-muted-foreground font-normal">(optional)</span></FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Business Class, Loyalty" {...field} readOnly={selectedBrand?.kind === "category"} data-testid="input-product-focus" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <DialogFooter className="pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createProject.isPending} data-testid="button-submit-project">
                 {createProject.isPending ? "Creating..." : selectedBrand ? "Create pitch & start quick research" : "Create workspace only"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
