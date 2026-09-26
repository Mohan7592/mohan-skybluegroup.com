import { Link } from "wouter";
import { Compass } from "lucide-react";

export function Header() {
  return (
    <header className="sticky top-0 z-40 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-16 w-full max-w-[1800px] items-center px-4 xl:px-6">
        <div className="mr-4 flex">
          <Link href="/" className="flex items-center gap-2 group" data-testid="link-home">
            <div className="bg-brand text-brand-foreground p-1.5 rounded-md flex items-center justify-center group-hover:bg-brand/90 transition-colors">
              <Compass className="h-5 w-5" />
            </div>
            <span className="font-semibold tracking-tight text-lg">Pitch Intelligence</span>
          </Link>
        </div>
        <div className="flex flex-1 items-center justify-end space-x-4">
          <nav className="flex items-center space-x-2">
            {/* Nav items could go here */}
          </nav>
        </div>
      </div>
    </header>
  );
}
