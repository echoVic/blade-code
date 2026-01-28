import { cn } from '@/lib/utils'
import { useIsDark } from '@/store/SettingsStore'
import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneLight, vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import remarkGfm from 'remark-gfm'

interface MarkdownRendererProps {
  content: string
  className?: string
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  const isDark = useIsDark()

  const components: Components = {
    code({ className, children, ...props }) {
      const match = /language-(\w+)/.exec(className || '')
      const isInline = !match
      const language = match ? match[1] : ''
      const codeString = String(children).replace(/\n$/, '')

      if (isInline) {
        return (
          <code className={cn("bg-[#F3F4F6] dark:bg-[#27272a] px-1.5 py-0.5 rounded text-[#111827] dark:text-[#E5E5E5] font-mono text-[13px]", className)} {...props}>
            {children}
          </code>
        )
      }

      return (
        <div className="relative my-4 rounded-lg overflow-hidden border border-[#E5E7EB] dark:border-[#27272a] bg-[#F9FAFB] dark:bg-[#1e1e1e]">
          <div className="flex items-center justify-between px-4 py-2 bg-[#F3F4F6] dark:bg-[#27272a] border-b border-[#E5E7EB] dark:border-[#27272a]">
            <span className="text-xs text-[#6B7280] dark:text-[#a1a1aa] font-mono">{language || 'text'}</span>
            <CopyButton content={codeString} />
          </div>
          <SyntaxHighlighter
            style={(isDark ? vscDarkPlus : oneLight) as Record<string, React.CSSProperties>}
            language={language}
            PreTag="div"
            wrapLongLines={true}
            customStyle={{
              margin: 0,
              padding: '16px',
              background: 'transparent',
              fontSize: '13px',
              lineHeight: '1.5',
            }}
          >
            {codeString}
          </SyntaxHighlighter>
        </div>
      )
    },
    p({ children }) {
      return <p className="mb-4 leading-relaxed last:mb-0">{children}</p>
    },
    ul({ children }) {
      return <ul className="pl-4 mb-4 space-y-1 list-disc last:mb-0">{children}</ul>
    },
    ol({ children }) {
      return <ol className="pl-4 mb-4 space-y-1 list-decimal last:mb-0">{children}</ol>
    },
    li({ children }) {
      return <li className="leading-relaxed">{children}</li>
    },
    h1({ children }) {
      return <h1 className="text-2xl font-bold mb-4 mt-6 text-[#111827] dark:text-[#E5E5E5]">{children}</h1>
    },
    h2({ children }) {
      return <h2 className="text-xl font-bold mb-3 mt-5 text-[#111827] dark:text-[#E5E5E5]">{children}</h2>
    },
    h3({ children }) {
      return <h3 className="text-lg font-bold mb-2 mt-4 text-[#111827] dark:text-[#E5E5E5]">{children}</h3>
    },
    blockquote({ children }) {
      return <blockquote className="border-l-2 border-[#22C55E] pl-4 italic text-[#6B7280] dark:text-[#a1a1aa] mb-4">{children}</blockquote>
    },
    a({ href, children }) {
      return (
        <a 
          href={href} 
          target="_blank" 
          rel="noopener noreferrer" 
          className="text-[#22C55E] hover:underline transition-colors"
        >
          {children}
        </a>
      )
    },
    table({ children }) {
      return <div className="overflow-x-auto mb-4 border border-[#E5E7EB] dark:border-[#27272a] rounded-lg"><table className="w-full text-sm text-left">{children}</table></div>
    },
    thead({ children }) {
      return <thead className="bg-[#F3F4F6] text-[#111827] dark:bg-[#27272a] dark:text-[#E5E5E5]">{children}</thead>
    },
    tbody({ children }) {
      return <tbody className="divide-y divide-[#E5E7EB] dark:divide-[#27272a]">{children}</tbody>
    },
    tr({ children }) {
      return <tr className="hover:bg-[#F3F4F6] dark:hover:bg-[#27272a]/50 transition-colors">{children}</tr>
    },
    th({ children }) {
      return <th className="px-4 py-3 font-medium whitespace-nowrap">{children}</th>
    },
    td({ children }) {
      return <td className="px-4 py-3 text-[#374151] dark:text-[#d4d4d8]">{children}</td>
    },
    hr() {
      return <hr className="my-6 border-[#E5E7EB] dark:border-[#27272a]" />
    }
  }

  return (
    <div className={cn("text-[14px] text-[#111827] dark:text-[#E5E5E5] font-mono break-words min-w-0 w-full", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      onClick={handleCopy}
      className="p-1 hover:bg-[#E5E7EB] dark:hover:bg-[#3f3f46] rounded-md transition-colors text-[#9CA3AF] dark:text-[#a1a1aa] hover:text-[#111827] dark:hover:text-[#E5E5E5]"
      title="Copy code"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-[#22C55E]" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}
