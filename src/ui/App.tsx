import { useState } from "react";
import type { PRRef } from "@/core";
import { Button } from "@/components/ui/button";
import { Reviews } from "@/ui/views/Reviews";
import { PRDetail } from "@/ui/views/PRDetail";
import { Repos } from "@/ui/views/Repos";
import { Settings } from "@/ui/views/Settings";

/**
 * The root view and the only place navigation lives.
 *
 * design.md's Web UI section names four views (there under their old name,
 * Inbox; renamed here to Reviews now that the view shows every PR's review
 * state, not just what is waiting on a human). Each one is self-contained
 * and fetches its own data, so this file owns nothing but which of them is
 * on screen. PRDetail deliberately does not own navigation either, which is
 * why the selected PR is held here and handed back down.
 */
type Tab = "reviews" | "repos" | "settings";

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "reviews", label: "Reviews" },
  { id: "repos", label: "Repos" },
  { id: "settings", label: "Settings" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("reviews");
  const [openPR, setOpenPR] = useState<PRRef | null>(null);

  // A selected PR outranks the tab bar: opening a PR from Reviews and then
  // clicking Repos should leave the detail view, not sit behind it.
  const showDetail = tab === "reviews" && openPR !== null;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <nav className="mx-auto flex max-w-5xl items-center gap-1 px-6 py-3" aria-label="Views">
          <span className="mr-4 font-semibold">LGTM</span>
          {TABS.map(({ id, label }) => (
            <Button
              key={id}
              variant={tab === id ? "secondary" : "ghost"}
              size="sm"
              aria-current={tab === id ? "page" : undefined}
              onClick={() => {
                setTab(id);
                if (id !== "reviews") setOpenPR(null);
              }}
            >
              {label}
            </Button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        {showDetail && openPR ? (
          <PRDetail prRef={openPR} onBack={() => setOpenPR(null)} />
        ) : tab === "reviews" ? (
          <Reviews onOpenPR={(ref) => setOpenPR(ref)} />
        ) : tab === "repos" ? (
          <Repos />
        ) : (
          <Settings />
        )}
      </main>
    </div>
  );
}

export default App;
