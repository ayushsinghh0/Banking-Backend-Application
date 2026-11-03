import { Fragment, type ReactNode } from 'react';

/*
 * Light formatting for Sphere's answers: paragraphs, bullet and numbered lists, and **bold**. The text is
 * the model's output, so it is only ever rendered as React text nodes: there is no HTML parsing and no
 * markdown library, and anything that looks like markup is shown as the characters it is.
 */

export type Block =
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'numbers'; items: string[]; start: number };

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBER = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  const close = () => {
    if (current) blocks.push(current);
    current = null;
  };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!raw.trim()) {
      close();
      continue;
    }
    const bullet = BULLET.exec(raw);
    const number = bullet ? null : NUMBER.exec(raw);
    if (bullet) {
      if (current?.kind !== 'bullets') {
        close();
        current = { kind: 'bullets', items: [] };
      }
      current.items.push(bullet[1] ?? '');
    } else if (number) {
      if (current?.kind !== 'numbers') {
        close();
        current = { kind: 'numbers', items: [], start: Number(number[1]) };
      }
      current.items.push(number[2] ?? '');
    } else {
      const heading = HEADING.exec(raw);
      const line = heading ? `**${heading[1]}**` : raw.trim();
      if (current?.kind !== 'paragraph') {
        close();
        current = { kind: 'paragraph', lines: [] };
      }
      current.lines.push(line);
    }
  }
  close();
  return blocks;
}

/** `**bold**` becomes <strong>; an unclosed marker (mid-stream) stays as typed */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+?\*\*)/g).map((part, index) =>
    part.length > 4 && part.startsWith('**') && part.endsWith('**') ? (
      <strong key={index} className="font-semibold">
        {part.slice(2, -2)}
      </strong>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    )
  );
}

export function FormattedText({ text }: { text: string }) {
  return (
    <div className="space-y-2.5 text-pretty text-[15px] leading-[22px] [overflow-wrap:anywhere]">
      {parseBlocks(text).map((block, index) => {
        if (block.kind === 'bullets') {
          return (
            <ul key={index} className="list-disc space-y-1 pl-5 marker:text-muted-foreground">
              {block.items.map((item, i) => (
                <li key={i}>{inline(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.kind === 'numbers') {
          return (
            <ol key={index} start={block.start} className="list-decimal space-y-1 pl-5 marker:text-muted-foreground">
              {block.items.map((item, i) => (
                <li key={i}>{inline(item)}</li>
              ))}
            </ol>
          );
        }
        return (
          <p key={index}>
            {block.lines.map((line, i) => (
              <Fragment key={i}>
                {i > 0 ? <br /> : null}
                {inline(line)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

/** The words without the formatting marks, for announcing an answer to screen readers */
export function plainText(text: string): string {
  return parseBlocks(text)
    .flatMap((block) => (block.kind === 'paragraph' ? block.lines : block.items))
    .map((line) => line.replace(/\*\*([^*]+?)\*\*/g, '$1'))
    .join('\n');
}
