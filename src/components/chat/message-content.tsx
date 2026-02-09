"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MessageContentProps {
  content: string;
}

export function MessageContent({ content }: MessageContentProps) {
  return (
    <div className="prose prose-invert prose-sm max-w-none break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-lg bg-background p-3 text-sm">{children}</pre>
          ),
          code: ({ children, className }) => {
            const isInline = !className;
            if (isInline) {
              return (
                <code className="rounded bg-background px-1.5 py-0.5 text-sm font-mono">
                  {children}
                </code>
              );
            }
            return <code className={className}>{children}</code>;
          },
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="border-collapse border border-border">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-border bg-muted px-3 py-1.5 text-left text-sm font-medium">{children}</th>
          ),
          td: ({ children }) => (
            <td className="border border-border px-3 py-1.5 text-sm">{children}</td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
