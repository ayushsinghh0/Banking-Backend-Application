import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { Button } from './button';
import { Field, Input, OtpInput, PasswordInput } from './input';
import { Amount, Avatar, BigAmount, Callout, CopyButton, DescriptionList, EmptyState, StatusBadge, humanize } from './primitives';
import { DataTable, ErrorState, Pagination } from './data';
import { ConfirmDialog } from './overlays';

describe('Button', () => {
  it('is a non-submitting button by default', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('type', 'button');
  });

  it('blocks clicks and announces progress while loading', async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Pay
      </Button>
    );
    const button = screen.getByRole('button', { name: 'Pay' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Field', () => {
  it('links label, hint and error to the control', () => {
    const { rerender } = render(
      <Field label="Email" hint="We never share it">
        {(p) => <Input {...p} />}
      </Field>
    );
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAccessibleDescription('We never share it');
    expect(input).toHaveAttribute('aria-invalid', 'false');

    rerender(
      <Field label="Email" hint="We never share it" error="Enter a valid email address">
        {(p) => <Input {...p} />}
      </Field>
    );
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid email address');
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription(/Enter a valid email address/);
  });

  it('marks optional fields', () => {
    render(
      <Field label="Address" optional>
        {(p) => <Input {...p} />}
      </Field>
    );
    expect(screen.getByText('(optional)')).toBeInTheDocument();
  });
});

describe('PasswordInput', () => {
  it('toggles visibility with an accessible control', async () => {
    render(<PasswordInput aria-label="Password" defaultValue="Secret-123" />);
    const input = screen.getByLabelText('Password');
    expect(input).toHaveAttribute('type', 'password');
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('OtpInput', () => {
  it('keeps only up to six digits', async () => {
    const onValueChange = vi.fn();
    render(<OtpInput aria-label="Code" onValueChange={onValueChange} />);
    await userEvent.type(screen.getByLabelText('Code'), '12a34-5678');
    expect(screen.getByLabelText('Code')).toHaveValue('123456');
    expect(onValueChange).toHaveBeenLastCalledWith('123456');
    expect(screen.getByLabelText('Code')).toHaveAttribute('autocomplete', 'one-time-code');
  });
});

describe('display primitives', () => {
  it('formats statuses consistently', () => {
    render(<StatusBadge status="PENDING_APPROVAL" />);
    expect(screen.getByText('Pending approval')).toBeInTheDocument();
    expect(humanize('UNDER_REVIEW')).toBe('Under review');
  });

  it('signs credits and debits', () => {
    render(
      <>
        <Amount paise="2500" direction="CREDIT" />
        <Amount paise="2500" direction="DEBIT" />
        <Amount paise="2500" />
      </>
    );
    expect(screen.getByText('+₹25.00')).toBeInTheDocument();
    expect(screen.getByText('-₹25.00')).toBeInTheDocument();
    expect(screen.getByText('₹25.00')).toBeInTheDocument();
  });

  it('derives avatar initials from the name part of an email, ignoring digits', () => {
    const { container } = render(<Avatar name="asha.rao@example.in" />);
    expect(container.textContent).toBe('AR');
    const digits = render(<Avatar name="asha.686749@e2e.test" />);
    expect(digits.container.textContent).toBe('A');
    const none = render(<Avatar name="1234@x.in" />);
    expect(none.container.textContent).toBe('?');
  });

  it('shows a large balance with the paise set apart, and a dash when unknown', () => {
    const { container, rerender } = render(<BigAmount paise="27400000" />);
    expect(container).toHaveTextContent('₹2,74,000.00');
    expect(screen.getByText('.00')).toBeInTheDocument();
    rerender(<BigAmount paise={null} />);
    expect(container).toHaveTextContent('—');
  });

  it('lays out label/value rows for every item', () => {
    render(<DescriptionList items={[{ label: 'Email', value: 'asha@example.com' }, { label: 'Role', value: 'Customer' }]} />);
    expect(screen.getByText('Email').tagName).toBe('DT');
    expect(screen.getByText('asha@example.com').tagName).toBe('DD');
    expect(screen.getAllByRole('term')).toHaveLength(2);
  });

  it('uses alert semantics for danger callouts', () => {
    render(<Callout tone="danger" title="Frozen" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Frozen');
  });

  it('renders empty states with an action', () => {
    render(<EmptyState title="No payees" description="Add one" action={<Button>Add payee</Button>} />);
    expect(screen.getByText('No payees')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add payee' })).toBeInTheDocument();
  });

  it('copies to the clipboard and confirms', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(<CopyButton value="12345678" label="Copy code" />);
    await user.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('12345678');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });
});

interface Row {
  id: string;
  name: string;
}
const columns = [
  { key: 'name', header: 'Name', cell: (r: Row) => r.name },
  { key: 'id', header: 'ID', cell: (r: Row) => r.id, hideOnMobile: true },
];

describe('DataTable', () => {
  it('shows skeleton rows while loading', () => {
    const { container } = render(
      <DataTable caption="People" columns={columns} rows={undefined} loading getRowKey={(r) => r.id} empty={{ title: 'Nobody' }} />
    );
    expect(container.querySelectorAll('tbody tr')).toHaveLength(5);
  });

  it('shows the empty state when there are no rows', () => {
    render(<DataTable caption="People" columns={columns} rows={[]} getRowKey={(r) => r.id} empty={{ title: 'Nobody here' }} />);
    expect(screen.getByText('Nobody here')).toBeInTheDocument();
  });

  it('shows a retryable error', async () => {
    const onRetry = vi.fn();
    render(
      <DataTable
        caption="People"
        columns={columns}
        rows={undefined}
        error={new ApiError({ status: 503, code: 'SERVICE_UNAVAILABLE', message: 'x' })}
        onRetry={onRetry}
        getRowKey={(r) => r.id}
        empty={{ title: 'Nobody' }}
      />
    );
    expect(screen.getByText('Temporarily unavailable')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('renders rows with a keyboard-accessible row action', async () => {
    const onRowClick = vi.fn();
    render(
      <DataTable
        caption="People"
        columns={columns}
        rows={[{ id: '1', name: 'Asha' }]}
        getRowKey={(r) => r.id}
        empty={{ title: 'Nobody' }}
        onRowClick={onRowClick}
        rowActionLabel={(r) => `Open ${r.name}`}
      />
    );
    expect(screen.getByRole('table', { name: 'People' })).toBeInTheDocument();
    screen.getByRole('button', { name: 'Open Asha' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).toHaveBeenCalledWith({ id: '1', name: 'Asha' });
  });
});

describe('ErrorState', () => {
  it('shows a support reference for server errors', () => {
    render(<ErrorState error={new ApiError({ status: 500, code: 'INTERNAL_SERVER_ERROR', message: 'x', correlationId: 'corr-7' })} />);
    expect(screen.getByText('Reference: corr-7')).toBeInTheDocument();
  });
});

describe('Pagination', () => {
  it('pages by offset and disables the ends', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<Pagination offset={0} limit={20} count={20} onChange={onChange} />);
    expect(screen.getByText('Showing 1–20')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(onChange).toHaveBeenCalledWith(20);

    rerender(<Pagination offset={20} limit={20} count={7} onChange={onChange} />);
    expect(screen.getByText('Showing 21–27')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /previous/i }));
    expect(onChange).toHaveBeenLastCalledWith(0);
  });
});

describe('ConfirmDialog', () => {
  it('waits for the action and closes on success', async () => {
    const onOpenChange = vi.fn();
    let resolve!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(
      <ConfirmDialog open onOpenChange={onOpenChange} title="Freeze account?" confirmLabel="Freeze" tone="destructive" onConfirm={onConfirm} />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Freeze' }));
    expect(screen.getByRole('button', { name: 'Freeze' })).toHaveAttribute('aria-busy', 'true');
    resolve();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('stays open when the action fails', async () => {
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog open onOpenChange={onOpenChange} title="Approve?" confirmLabel="Approve" onConfirm={() => Promise.reject(new Error('no'))} />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).not.toHaveAttribute('aria-busy'));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
