import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import scss from 'react-syntax-highlighter/dist/esm/languages/prism/scss';
import shellSession from 'react-syntax-highlighter/dist/esm/languages/prism/shell-session';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import { oneLight, vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface CodeBlockHighlighterProps {
  code: string;
  language: string;
  isDark: boolean;
}

SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('sh', bash);
SyntaxHighlighter.registerLanguage('shell', bash);
SyntaxHighlighter.registerLanguage('shell-session', shellSession);
SyntaxHighlighter.registerLanguage('css', css);
SyntaxHighlighter.registerLanguage('diff', diff);
SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('js', javascript);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('jsx', jsx);
SyntaxHighlighter.registerLanguage('markdown', markdown);
SyntaxHighlighter.registerLanguage('md', markdown);
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('py', python);
SyntaxHighlighter.registerLanguage('scss', scss);
SyntaxHighlighter.registerLanguage('tsx', tsx);
SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('ts', typescript);
SyntaxHighlighter.registerLanguage('yaml', yaml);
SyntaxHighlighter.registerLanguage('yml', yaml);

export function CodeBlockHighlighter({
  code,
  language,
  isDark,
}: CodeBlockHighlighterProps) {
  return (
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
      {code}
    </SyntaxHighlighter>
  );
}
