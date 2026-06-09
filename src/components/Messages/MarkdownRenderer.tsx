import { useMemo } from 'react';
import './MarkdownRenderer.css';

// Detect if text contains markdown patterns worth rendering
export function hasMarkdown(text: string): boolean {
  return /(\*\*.+?\*\*|__.+?__|`.+?`|^#{1,6}\s|^\s*[-*]\s|^\s*\d+\.\s|^\s*>.+|!\[.+?\]\(.+?\)|\[.+?\]\(.+?\))/m.test(text);
}

// Key type for React elements
type ReactNode = React.ReactNode;

let keyCounter = 0;
function nextKey(): string {
  return `md-${++keyCounter}`;
}

// Allowlist URL schemes for links/images coming from untrusted message text.
// Strips control chars/whitespace first so `java\nscript:` style obfuscation
// cannot slip past the scheme check. Returns null for disallowed/unsafe URLs.
const ALLOWED_URL_SCHEMES = ['http', 'https', 'tg', 'mailto'];
function safeUrl(url: string): string | null {
  // eslint-disable-next-line no-control-regex
  const cleaned = url.replace(/[\x00-\x20]+/g, '');
  const schemeMatch = cleaned.match(/^([a-z][a-z0-9+.-]*):/i);
  if (schemeMatch && !ALLOWED_URL_SCHEMES.includes(schemeMatch[1].toLowerCase())) {
    return null;
  }
  return url.trim();
}

// Parse inline markdown into React nodes
function parseInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let remaining = text;

  // Combined inline pattern:
  // 1. inline code: `...`
  // 2. images: ![alt](url)
  // 3. links: [text](url)
  // 4. bold+italic: ***...***, ___...___
  // 5. bold: **...**, __...__
  // 6. italic: *...*, _..._
  const inlinePattern = /(`[^`]+?`)|!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|(\*\*\*|___)(.+?)\3|(\*\*|__)(.+?)\8|(\*|_)(.+?)\10/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlinePattern.exec(remaining)) !== null) {
    // Add text before this match
    if (match.index > lastIndex) {
      nodes.push(remaining.slice(lastIndex, match.index));
    }

    if (match[1]) {
      // Inline code
      const code = match[1].slice(1, -1);
      nodes.push(<code key={nextKey()} className="md-inline-code">{code}</code>);
    } else if (match[2] !== undefined && match[3]) {
      // Image: ![alt](url) — drop unsafe schemes, fall back to alt/raw text
      const safe = safeUrl(match[3]);
      if (safe) {
        nodes.push(
          <img key={nextKey()} className="md-image" src={safe} alt={match[2]} />
        );
      } else {
        nodes.push(match[2] || match[3]);
      }
    } else if (match[4] && match[5]) {
      // Link: [text](url) — drop unsafe schemes, render as plain text instead
      const safe = safeUrl(match[5]);
      if (safe) {
        nodes.push(
          <a key={nextKey()} className="md-link" href={safe} target="_blank" rel="noopener noreferrer">
            {match[4]}
          </a>
        );
      } else {
        nodes.push(match[4]);
      }
    } else if (match[6] && match[7]) {
      // Bold+italic: ***text***
      nodes.push(
        <strong key={nextKey()} className="md-bold"><em className="md-italic">{parseInline(match[7])}</em></strong>
      );
    } else if (match[8] && match[9]) {
      // Bold: **text**
      nodes.push(
        <strong key={nextKey()} className="md-bold">{parseInline(match[9])}</strong>
      );
    } else if (match[10] && match[11]) {
      // Italic: *text*
      nodes.push(
        <em key={nextKey()} className="md-italic">{parseInline(match[11])}</em>
      );
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < remaining.length) {
    nodes.push(remaining.slice(lastIndex));
  }

  return nodes;
}

interface Block {
  type: 'code-block' | 'heading' | 'blockquote' | 'ul-item' | 'ol-item' | 'paragraph';
  content: string;
  level?: number; // heading level or list nesting
  lang?: string;  // code block language
}

// Parse text into blocks
function parseBlocks(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block: ```lang ... ```
    if (line.trimStart().startsWith('```')) {
      const lang = line.trimStart().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      // Skip closing ```
      if (i < lines.length) i++;
      blocks.push({ type: 'code-block', content: codeLines.join('\n'), lang });
      continue;
    }

    // Heading: # ... (up to ######)
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      blocks.push({ type: 'heading', content: headingMatch[2], level: headingMatch[1].length });
      i++;
      continue;
    }

    // Blockquote: > ...
    if (line.match(/^\s*>\s?/)) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].match(/^\s*>\s?/)) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', content: quoteLines.join('\n') });
      continue;
    }

    // Unordered list: - item or * item
    if (line.match(/^\s*[-*]\s+/)) {
      blocks.push({ type: 'ul-item', content: line.replace(/^\s*[-*]\s+/, '') });
      i++;
      continue;
    }

    // Ordered list: 1. item
    if (line.match(/^\s*\d+\.\s+/)) {
      blocks.push({ type: 'ol-item', content: line.replace(/^\s*\d+\.\s+/, '') });
      i++;
      continue;
    }

    // Regular paragraph - collect consecutive non-empty, non-special lines
    if (line.trim() === '') {
      // Empty line: skip but preserve paragraph break
      i++;
      continue;
    }

    // Paragraph line
    blocks.push({ type: 'paragraph', content: line });
    i++;
  }

  return blocks;
}

// Group consecutive list items
interface RenderGroup {
  type: 'single' | 'ul' | 'ol';
  blocks: Block[];
}

function groupBlocks(blocks: Block[]): RenderGroup[] {
  const groups: RenderGroup[] = [];

  for (const block of blocks) {
    if (block.type === 'ul-item') {
      const last = groups[groups.length - 1];
      if (last && last.type === 'ul') {
        last.blocks.push(block);
      } else {
        groups.push({ type: 'ul', blocks: [block] });
      }
    } else if (block.type === 'ol-item') {
      const last = groups[groups.length - 1];
      if (last && last.type === 'ol') {
        last.blocks.push(block);
      } else {
        groups.push({ type: 'ol', blocks: [block] });
      }
    } else {
      groups.push({ type: 'single', blocks: [block] });
    }
  }

  return groups;
}

function renderBlock(block: Block): ReactNode {
  switch (block.type) {
    case 'code-block':
      return (
        <div key={nextKey()} className="md-code-block-wrapper">
          {block.lang && <div className="md-code-lang">{block.lang}</div>}
          <pre className="md-code-block"><code>{block.content}</code></pre>
        </div>
      );

    case 'heading': {
      const level = block.level as 1 | 2 | 3 | 4 | 5 | 6;
      const headingClass = `md-heading md-h${level}`;
      const content = parseInline(block.content);
      const key = nextKey();
      if (level === 1) return <h1 key={key} className={headingClass}>{content}</h1>;
      if (level === 2) return <h2 key={key} className={headingClass}>{content}</h2>;
      if (level === 3) return <h3 key={key} className={headingClass}>{content}</h3>;
      if (level === 4) return <h4 key={key} className={headingClass}>{content}</h4>;
      if (level === 5) return <h5 key={key} className={headingClass}>{content}</h5>;
      return <h6 key={key} className={headingClass}>{content}</h6>;
    }

    case 'blockquote':
      return (
        <blockquote key={nextKey()} className="md-blockquote">
          {parseBlocks(block.content).map(b => renderBlock(b))}
        </blockquote>
      );

    case 'paragraph':
      return <p key={nextKey()} className="md-paragraph">{parseInline(block.content)}</p>;

    case 'ul-item':
      return <li key={nextKey()} className="md-list-item">{parseInline(block.content)}</li>;

    case 'ol-item':
      return <li key={nextKey()} className="md-list-item">{parseInline(block.content)}</li>;

    default:
      return <p key={nextKey()} className="md-paragraph">{block.content}</p>;
  }
}

interface MarkdownRendererProps {
  text: string;
}

export const MarkdownRenderer = ({ text }: MarkdownRendererProps) => {
  const rendered = useMemo(() => {
    // Reset key counter for deterministic keys per render
    keyCounter = 0;

    const blocks = parseBlocks(text);
    const groups = groupBlocks(blocks);

    return groups.map((group) => {
      if (group.type === 'ul') {
        return (
          <ul key={nextKey()} className="md-list md-ul">
            {group.blocks.map(b => renderBlock(b))}
          </ul>
        );
      }
      if (group.type === 'ol') {
        return (
          <ol key={nextKey()} className="md-list md-ol">
            {group.blocks.map(b => renderBlock(b))}
          </ol>
        );
      }
      return renderBlock(group.blocks[0]);
    });
  }, [text]);

  return <div className="md-rendered">{rendered}</div>;
};
