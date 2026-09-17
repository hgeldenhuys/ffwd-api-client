import { useEffect, useState } from "react";
import { useActionData, useNavigate, type ActionFunctionArgs } from "react-router";
import { toast } from "sonner";
import { Button, Input, Label } from "@ffwd/api-client-react";
export async function action({ request }: ActionFunctionArgs) {
  // The sign-in POST goes to /api/session (see the fetch below); this action
  // only exists so the route participates in form handling if JS is off.
  void request;
  return null;
}

export default function SignIn() {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const actionData = useActionData();

  useEffect(() => {
    if (actionData) return;
  }, [actionData]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      });
      if (res.status === 204) {
        navigate("/", { replace: true });
        return;
      }
      const data = await res.json().catch(() => null);
      toast.error(data?.error?.message ?? "Sign in failed: try again.");
    } catch (err: any) {
      toast.error(err?.message ?? "Sign in failed: the server could not be reached.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border bg-card p-6 shadow-sm">
        <div className="space-y-1.5">
          <h1 className="text-base font-semibold">Sign in</h1>
          <p className="text-muted-foreground">Enter the access key to open the ffwd API client.</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="key">Access key</Label>
          <Input
            id="key"
            type="password"
            autoFocus
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Access key"
          />
        </div>
        <Button type="submit" className="w-full" disabled={busy || !key}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
