import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function LegacyMcpLinkPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader><CardTitle>This linking method has been retired</CardTitle></CardHeader>
        <CardContent>
          Ask the Thinkarr companion for a new private Plex account link. Legacy MCP tokens and unsigned channel links are no longer supported.
        </CardContent>
      </Card>
    </main>
  );
}
