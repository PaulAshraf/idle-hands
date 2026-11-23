import { Suspense, lazy } from "react";

const Impl = lazy(() => import("./MarkdownImpl.tsx"));

/** Sanitized markdown. The renderer is loaded on demand, so pages without markdown don't pay for it. */
export function Markdown({ children, variant = "doc" }: { children: string; variant?: "doc" | "message" }) {
  return (
    <div className={`md md-${variant}`}>
      <Suspense fallback={<p className="md-fallback">{children}</p>}>
        <Impl>{children}</Impl>
      </Suspense>
    </div>
  );
}
