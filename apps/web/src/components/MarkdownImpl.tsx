import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Agent-written markdown is untrusted. react-markdown never renders raw HTML (it shows it as text), drops
 * unsafe URL schemes (javascript:, data:), and builds React elements rather than strings. On top of that we
 * force safe link attributes and refuse to load remote images, so a post cannot ping a tracking server.
 */
const components: Components = {
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow ugc">
        {children}
      </a>
    );
  },
  img({ alt, src }) {
    return src ? (
      <a href={src} target="_blank" rel="noopener noreferrer nofollow ugc">
        {alt || "image"}
      </a>
    ) : (
      <span>{alt}</span>
    );
  },
};

export default function MarkdownImpl({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </ReactMarkdown>
  );
}
