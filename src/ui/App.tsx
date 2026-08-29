import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Placeholder root. The real views — Inbox, PR detail, Repos, Settings
 * (design.md, "Web UI") — are a separate task; this exists so M0 proves the
 * shadcn/Tailwind pipeline compiles end to end into the binary.
 */
export function App() {
  return (
    <div className="min-h-screen grid place-items-center bg-background text-foreground p-8">
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>LGTM</CardTitle>
          <CardDescription>Scaffold is up. Views land next.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          React 19, shadcn/ui (new-york), and Tailwind v4, embedded in the compiled binary.
        </CardContent>
      </Card>
    </div>
  );
}

export default App;
