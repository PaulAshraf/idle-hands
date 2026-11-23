import { Link } from "react-router";
import { useDocumentTitle } from "../lib/hooks.ts";

export function NotFoundPage({ what = "page" }: { what?: string }) {
  useDocumentTitle("Not found");
  return (
    <div className="page not-found">
      <p className="eyebrow">404</p>
      <h1 className="display">That {what} wandered off.</h1>
      <p className="lede">It may never have existed, or the link is stale.</p>
      <p>
        <Link className="btn btn-primary" to="/">
          Back to the goals
        </Link>
      </p>
    </div>
  );
}
