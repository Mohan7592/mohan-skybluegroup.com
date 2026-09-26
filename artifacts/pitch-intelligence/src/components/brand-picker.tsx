import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Globe, Sparkles } from "lucide-react";
import { getBrandOptions } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type BrandOption = {
  kind: "company" | "brand" | "category";
  name: string;
  parent: string | null;
  category: string | null;
  website: string;
  sourceUrl: string;
  evidenceQuote: string;
  regionalEntity: { name: string; sourceUrl: string; evidenceQuote: string } | null;
  selectionToken: string;
};

export function BrandPicker({
  onSelect,
}: {
  onSelect: (option: BrandOption | null, enteredName: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState(false);
  const [options, setOptions] = useState<BrandOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const lastRequested = useRef("");
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => { requestId.current += 1; controllerRef.current?.abort(); }, []);

  const searchName = useCallback(async (name: string) => {
    if (lastRequested.current === name) return;
    lastRequested.current = name;
    const currentRequest = ++requestId.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 28_000);
    setLoading(true);
    setSearched(false);
    setOptions([]);
    setError(null);
    try {
      const result = await getBrandOptions({ query: name }, { signal: controller.signal });
      if (currentRequest !== requestId.current) return;
      setOptions(result.options);
      setSearched(true);
    } catch (cause) {
      if (currentRequest !== requestId.current) return;
      lastRequested.current = "";
      setSearched(true);
      setError(controller.signal.aborted
        ? "Official source lookup timed out. Try a more specific brand or official domain."
        : cause instanceof Error ? cause.message : "Brand search failed.");
    } finally {
      window.clearTimeout(timeout);
      if (controllerRef.current === controller) controllerRef.current = null;
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const name = query.trim();
    if (name.length < 3) return;
    const timer = window.setTimeout(() => { void searchName(name); }, 900);
    return () => window.clearTimeout(timer);
  }, [query, searchName]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = query.trim();
    if (name.length < 2) {
      setError("Enter at least two letters to find brand options.");
      return;
    }
    void searchName(name);
  }

  return (
    <div className="w-full max-w-2xl text-left">
      <form onSubmit={search} className="relative flex items-center">
        <Sparkles className="absolute left-5 h-5 w-5 text-brand pointer-events-none" aria-hidden="true" />
        <Input
          value={query}
          onChange={(event) => {
            requestId.current += 1;
            controllerRef.current?.abort();
            lastRequested.current = "";
            setQuery(event.target.value);
            setOptions([]);
            setSearched(false);
            setError(null);
            setLoading(false);
          }}
          placeholder="Enter the client or brand name"
          aria-label="Company or brand name"
          data-testid="hero-brand-name"
          className="h-16 rounded-2xl pl-14 pr-36 text-base md:text-lg border-2 shadow-sm"
          maxLength={120}
        />
        <Button type="submit" disabled={loading} className="absolute right-2 h-12 rounded-xl px-4 md:px-6" data-testid="hero-button-start">
          {loading ? "Checking sources..." : "Find pitch focus"}
        </Button>
      </form>
      <p className="mt-2 text-sm text-muted-foreground text-center">
         Choose a source-backed company, brand, or category before setting the pitch brief.
      </p>
      {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
      {searched && (
         <div className="mt-5 rounded-2xl border bg-slate-50 text-slate-900 dark:bg-slate-900 dark:text-slate-50 p-4 shadow-sm" aria-live="polite">
           <h2 className="text-base font-semibold mb-1">Choose the pitch focus</h2>
          <p className="text-xs text-muted-foreground mb-4">
             Each option has a cited source. Choosing a company means pitching the whole company, not a specific brand.
          </p>
          {options.length ? (
            <div className="space-y-2">
              {options.map((option) => (
                <div key={`${option.kind}:${option.name}:${option.sourceUrl}`} className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{option.name}</span>
                      <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] capitalize text-muted-foreground">{option.kind}</span>
                    </div>
                    {(option.parent || option.category) && (
                      <p className="text-xs text-muted-foreground mt-1">
                        {[option.parent && `Part of ${option.parent}`, option.category && `Focus: ${option.category}`].filter(Boolean).join(" · ")}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1">{option.website}</p>
                    {option.regionalEntity ? <p className="text-xs text-muted-foreground mt-1">
                      UAE/regional entity: <a href={option.regionalEntity.sourceUrl} target="_blank" rel="noreferrer" className="text-brand underline" title={option.regionalEntity.evidenceQuote}>{option.regionalEntity.name}</a>
                    </p> : <p className="text-xs text-muted-foreground mt-1">UAE/regional entity: Not independently verified</p>}
                    <a href={option.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center text-xs text-brand hover:underline mt-1 break-all">
                      <Globe className="h-3 w-3 mr-1 shrink-0" />View official source
                    </a>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">“{option.evidenceQuote}”</p>
                  </div>
                   <Button type="button" variant="outline" className="shrink-0" onClick={() => onSelect(option, query.trim())} data-testid={`button-select-brand-${option.kind}-${option.name}`}>
                     Pitch this {option.kind}
                  </Button>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-muted-foreground">No source-backed options found. Check the spelling or try a more specific brand name.</p>}
          <Button type="button" variant="link" className="mt-3 px-0 text-xs" onClick={() => onSelect(null, query.trim())}>
             Create a workspace for “{query.trim()}” without starting research
          </Button>
        </div>
      )}
      {!searched && !loading && query.trim().length > 1 && !error && (
        <p className="mt-2 text-center text-xs text-muted-foreground">Official options will appear here before research starts.</p>
      )}
      {loading && <p className="mt-4 text-sm text-muted-foreground text-center" role="status">Checking live official sources. This may take up to 30 seconds.</p>}
    </div>
  );
}