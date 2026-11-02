import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FormattedText, parseBlocks, plainText } from './format';

describe('parseBlocks', () => {
  it('splits paragraphs on blank lines and keeps single line breaks inside them', () => {
    expect(parseBlocks('First line\nsecond line\n\nNext paragraph')).toEqual([
      { kind: 'paragraph', lines: ['First line', 'second line'] },
      { kind: 'paragraph', lines: ['Next paragraph'] },
    ]);
  });

  it('reads bullet lists written with -, * or •, and numbered lists', () => {
    expect(parseBlocks('Your accounts:\n- Savings\n* Current\n• Joint\n\n1. Open Payees\n2) Add a payee')).toEqual([
      { kind: 'paragraph', lines: ['Your accounts:'] },
      { kind: 'bullets', items: ['Savings', 'Current', 'Joint'] },
      { kind: 'numbers', items: ['Open Payees', 'Add a payee'], start: 1 },
    ]);
  });

  it('turns a markdown heading into a plain line', () => {
    expect(parseBlocks('## Spending\nYou spent less')).toEqual([{ kind: 'paragraph', lines: ['**Spending**', 'You spent less'] }]);
  });

  it('starts a new block when the kind of line changes', () => {
    expect(parseBlocks('- one\nafter\n3. three')).toEqual([
      { kind: 'bullets', items: ['one'] },
      { kind: 'paragraph', lines: ['after'] },
      { kind: 'numbers', items: ['three'], start: 3 },
    ]);
  });

  it('handles empty text', () => {
    expect(parseBlocks('')).toEqual([]);
    expect(parseBlocks('\r\n\r\n')).toEqual([]);
  });
});

describe('FormattedText', () => {
  it('renders bold, lists and paragraphs as elements', () => {
    const { container } = render(<FormattedText text={'You have **₹1,25,500.75** in total.\n\n- Savings\n- Current'} />);
    expect(screen.getByText('₹1,25,500.75').tagName).toBe('STRONG');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('ul')).not.toBeNull();
  });

  it('never turns text into markup', () => {
    const { container } = render(<FormattedText text={'<img src=x onerror="alert(1)"> and <b>bold</b>'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container).toHaveTextContent('<img src=x onerror="alert(1)"> and <b>bold</b>');
  });

  it('shows an unfinished bold marker as it is while the answer streams in', () => {
    render(<FormattedText text="Balance is **₹1,2" />);
    expect(screen.getByText('Balance is **₹1,2')).toBeInTheDocument();
  });

  it('numbers an ordered list from where it starts', () => {
    const { container } = render(<FormattedText text={'3. Third\n4. Fourth'} />);
    expect(container.querySelector('ol')).toHaveAttribute('start', '3');
  });
});

describe('plainText', () => {
  it('drops the formatting marks for screen-reader announcements', () => {
    expect(plainText('## Hello\nYou have **₹5**.\n- one\n2. two')).toBe('Hello\nYou have ₹5.\none\ntwo');
  });
});
