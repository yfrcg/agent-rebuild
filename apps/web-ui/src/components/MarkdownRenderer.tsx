/**
 * ?????CS336 ???
 * ???apps/web-ui/src/components/MarkdownRenderer.tsx
 * ???Web UI ??????
 * ???????????????? Gateway ??????
 * ???????????????????????????????????? README ????????????????
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || "");
          const isInline = !match && !String(children).includes("\n");

          if (isInline) {
            return (
              <code className="md-inline-code" {...props}>
                {children}
              </code>
            );
          }

          return (
            <pre className="md-code-block">
              <code className={className} {...props}>
                {String(children).replace(/\n$/, "")}
              </code>
            </pre>
          );
        },
        table({ children }) {
          return (
            <div className="md-table-wrapper">
              <table className="md-table">{children}</table>
            </div>
          );
        },
        a({ href, children }) {
          return (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          );
        },
        blockquote({ children }) {
          return <blockquote className="md-blockquote">{children}</blockquote>;
        },
        hr() {
          return <hr className="md-hr" />;
        },
        ul({ children }) {
          return <ul className="md-list">{children}</ul>;
        },
        ol({ children }) {
          return <ol className="md-list md-ordered-list">{children}</ol>;
        },
        h1({ children }) {
          return <h1 className="md-h1">{children}</h1>;
        },
        h2({ children }) {
          return <h2 className="md-h2">{children}</h2>;
        },
        h3({ children }) {
          return <h3 className="md-h3">{children}</h3>;
        },
        h4({ children }) {
          return <h4 className="md-h4">{children}</h4>;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
