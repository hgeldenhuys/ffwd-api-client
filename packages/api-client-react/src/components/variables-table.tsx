import { useState } from "react";
import { KeyRound, EyeOff, Lock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Badge } from "./ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { relativeTime, type SecretMeta } from "../lib/types";

export interface VarRow {
  key: string;
  value: string;
  enabled?: boolean;
  type?: string;
  secret?: SecretMeta;
}

/**
 * The variables table for one scope (collection or environment). A secret row
 * never shows a value: a lock, a hidden field, "Set value…", "Clear", and
 * `set · updated <relative> · used <relative>`. Only the PUT carries a value.
 */
export function VariablesTable({
  rows,
  scope,
  scopeId,
  onChanged,
}: {
  rows: VarRow[];
  scope: "collection" | "environment";
  scopeId: string;
  onChanged: () => void;
}) {
  const [setValueFor, setSetValueFor] = useState<string | null>(null);
  const [newValue, setNewValue] = useState("");
  const [confirmClear, setConfirmClear] = useState<string | null>(null);

  async function setType(row: VarRow, secret: boolean) {
    if (secret) {
      setSetValueFor(row.key);
      setNewValue("");
      return;
    }
    // secret → default: clear the stored value server-side
    const res = await fetch(`/api/secrets/${scope}/${scopeId}/${encodeURIComponent(row.key)}`, { method: "DELETE" });
    if (res.ok || res.status === 404) {
      onChanged();
      toast.success(`"${row.key}" is now a default variable: fill the value in the table.`);
    } else {
      const data = await res.json().catch(() => null);
      toast.error(data?.error?.message ?? "The secret could not be cleared.");
    }
  }

  async function saveValue() {
    if (!setValueFor) return;
    const res = await fetch(`/api/secrets/${scope}/${scopeId}/${encodeURIComponent(setValueFor)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: newValue }),
    });
    if (res.status === 204) {
      toast.success(`The value of "${setValueFor}" is stored. It will not be shown again; send to see it used.`);
      setSetValueFor(null);
      onChanged();
    } else {
      const data = await res.json().catch(() => null);
      toast.error(data?.error?.message ?? "The value could not be stored.");
    }
  }

  async function clearValue() {
    if (!confirmClear) return;
    const res = await fetch(`/api/secrets/${scope}/${scopeId}/${encodeURIComponent(confirmClear)}`, { method: "DELETE" });
    setConfirmClear(null);
    if (res.status === 204 || res.status === 404) {
      onChanged();
      toast.success("The stored value is cleared.");
    } else {
      const data = await res.json().catch(() => null);
      toast.error(data?.error?.message ?? "The value could not be cleared.");
    }
  }

  if (rows.length === 0) {
    return <p className="p-3 text-muted-foreground">No variables in this scope yet. Add a row below, or import an environment.</p>;
  }

  return (
    <div className="text-[13px]">
      <table className="w-full">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="px-3 py-1.5 font-medium">Key</th>
            <th className="px-3 py-1.5 font-medium">Type</th>
            <th className="px-3 py-1.5 font-medium">Value</th>
            <th className="px-3 py-1.5 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isSecret = row.type === "secret" || row.secret;
            const meta = row.secret;
            return (
              <tr key={row.key} className="border-b last:border-0">
                <td className="px-3 py-1.5 font-mono">{row.key}</td>
                <td className="px-3 py-1.5">
                  <Badge variant="outline" className="gap-1">
                    {isSecret ? <Lock className="size-3" /> : <KeyRound className="size-3" />}
                    {isSecret ? "secret" : "default"}
                  </Badge>
                </td>
                <td className="px-3 py-1.5">
                  {isSecret ? (
                    <span className="font-mono text-muted-foreground">••••••</span>
                  ) : (
                    <Input
                      className="h-7 font-mono text-[13px]"
                      value={row.value}
                      onChange={(e) => {
                        row.value = e.target.value;
                      }}
                      onBlur={() => onChanged()}
                    />
                  )}
                </td>
                <td className="px-3 py-1.5 text-right whitespace-nowrap">
                  {isSecret ? (
                    <span className="flex items-center justify-end gap-2">
                      <span className="text-muted-foreground">
                        {meta?.has_value
                          ? `set · updated ${relativeTime(meta.updated_at)} · used ${relativeTime(meta.last_used_at)}`
                          : "not set"}
                      </span>
                      {meta?.has_value && (
                        <>
                          <Button variant="ghost" size="sm" className="h-7" onClick={() => { setSetValueFor(row.key); setNewValue(""); }}>
                            Set value…
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7" onClick={() => setConfirmClear(row.key)}>
                            Clear
                          </Button>
                        </>
                      )}
                      {!meta?.has_value && (
                        <Button variant="ghost" size="sm" className="h-7" onClick={() => { setSetValueFor(row.key); setNewValue(""); }}>
                          Set value…
                        </Button>
                      )}
                    </span>
                  ) : (
                    <Button variant="ghost" size="sm" className="h-7" onClick={() => setType(row, true)}>
                      Make secret
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <Dialog open={setValueFor !== null} onOpenChange={(o) => !o && setSetValueFor(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <EyeOff className="size-4" /> Set value for “{setValueFor}”
            </DialogTitle>
            <DialogDescription>
              The value is stored encrypted on the server and shown only this once while you type it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="secret-value">Value</Label>
            <Input
              id="secret-value"
              type="password"
              autoFocus
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && newValue && saveValue()}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSetValueFor(null)}>Cancel</Button>
            <Button disabled={!newValue} onClick={saveValue}>Store value</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmClear !== null} onOpenChange={(o) => !o && setConfirmClear(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Clear “{confirmClear}”?</DialogTitle>
            <DialogDescription>The stored value is deleted. Requests using it will send an empty value until you set it again.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmClear(null)}>Cancel</Button>
            <Button variant="destructive" onClick={clearValue}>Clear value</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
