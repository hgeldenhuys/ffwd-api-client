import { useNavigate } from "react-router";
import { ApiClient, createQueryUrlState } from "@ffwd/api-client-react";

/**
 * The reference host's page: the whole client is the embeddable component.
 * The host owns the page frame and the sign-in redirect; the component owns
 * the three-pane UI. Selection (collection / request / environment / tabs)
 * lives in the URL through the query adapter, which writes the query string
 * itself — React Router's setSearchParams would re-encode `r` through
 * URLSearchParams.toString() (+ for space, %2F joiners) and undo the
 * single-encoded address bar (build 4).
 */
export default function App() {
  const navigate = useNavigate();
  return (
    <ApiClient
      apiBase="/api/ffwd"
      className="h-screen"
      onUnauthorized={() => navigate("/sign-in")}
      urlState={createQueryUrlState()}
    />
  );
}
