import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ApiClient,
  Button,
  Input,
  Label,
} from "@ffwd/api-client-react";
import "@ffwd/api-client-react/styles.css";

function SignIn({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!key || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      });
      if (res.status === 204) onDone();
      else setError("That access key is not correct: check it and try again.");
    } catch {
      setError("The server could not be reached. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen items-center justify-center">
      <form onSubmit={submit} className="ffwd-api-client space-y-3 rounded-lg border p-5" style={{ width: "20rem" }}>
        <h1 className="text-sm font-semibold">ffwd API client</h1>
        <p className="text-[13px] text-[var(--muted-foreground)]">Enter this host's access key to continue.</p>
        <Label htmlFor="access-key">Access key</Label>
        <Input
          id="access-key"
          type="password"
          autoFocus
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="access key"
        />
        {error && <p className="text-[13px] text-[var(--destructive)]">{error}</p>}
        <Button type="submit" disabled={busy || !key} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}

function App() {
  const [authed, setAuthed] = useState(true);
  if (!authed) return <SignIn onDone={() => setAuthed(true)} />;
  return (
    <ApiClient
      apiBase="/api/ffwd"
      className="h-screen"
      onUnauthorized={() => setAuthed(false)}
    />
  );
}

createRoot(document.getElementById("root")!).render(<App />);
