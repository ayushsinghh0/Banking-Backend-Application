import { http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { server } from '@/test/server';
import { apiUrl, fail, ok, renderWithApp } from '@/test/render';
import { aProfile } from '@/test/fixtures';
import type { CustomerProfile } from '@/lib/api/types';
import { mockCustomerApi } from './testing';
import ProfilePage from './ProfilePage';

const render = () => renderWithApp(<ProfilePage />, { route: '/profile' });
type User = ReturnType<typeof renderWithApp>['user'];

/** YYYY-MM-DD for someone `years` old today (local calendar) */
function birthdayYearsAgo(years: number): string {
  const d = new Date();
  return `${d.getFullYear() - years}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function profileApi(profile: CustomerProfile | null, respond?: (body: Record<string, unknown>) => Response) {
  const sent: Array<{ method: string; body: Record<string, unknown> }> = [];
  mockCustomerApi({ profile });
  const handler = async ({ request }: { request: Request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    sent.push({ method: request.method, body });
    return respond ? respond(body) : ok(aProfile({ ...(profile ?? {}), ...(body as Partial<CustomerProfile>), kycStatus: 'PENDING' }));
  };
  server.use(http.post(apiUrl('/customers/me'), handler), http.patch(apiUrl('/customers/me'), handler));
  return sent;
}

async function fillCreate(user: User, o: { name?: string; phone?: string; dob?: string; address?: string } = {}) {
  const { name = 'Asha Rao', phone = '+91 98765 43210', dob = '1992-04-12', address = '12 MG Road, Pune' } = o;
  if (name) await user.type(await screen.findByLabelText('Full name'), name);
  if (phone) await user.type(screen.getByLabelText('Mobile number'), phone);
  if (dob) await user.type(screen.getByLabelText('Date of birth'), dob);
  if (address) await user.type(screen.getByLabelText(/address/i), address);
}

describe('ProfilePage', () => {
  it('asks a new customer to create a profile, then shows that verification has started', async () => {
    const sent = profileApi(null, () => ok(aProfile({ kycStatus: 'PENDING' }), 201));
    const { user } = render();
    expect(await screen.findByRole('heading', { name: 'Create your profile' })).toBeInTheDocument();
    await fillCreate(user);
    await user.click(screen.getByRole('button', { name: 'Create profile' }));
    expect(await screen.findByText('Verification in progress')).toBeInTheDocument();
    expect(sent).toEqual([
      {
        method: 'POST',
        body: { fullName: 'Asha Rao', phoneNumber: '+919876543210', dateOfBirth: '1992-04-12T00:00:00.000Z', address: '12 MG Road, Pune' },
      },
    ]);
  });

  it('leaves out an empty address', async () => {
    const sent = profileApi(null, () => ok(aProfile({ kycStatus: 'PENDING', address: null }), 201));
    const { user } = render();
    await fillCreate(user, { address: '' });
    await user.click(screen.getByRole('button', { name: 'Create profile' }));
    await screen.findByText('Verification in progress');
    expect(sent[0]!.body).not.toHaveProperty('address');
  });

  it('applies the bank’s rules for names, phone numbers and age before sending', async () => {
    const sent = profileApi(null);
    const { user } = render();
    await fillCreate(user, { name: 'Asha 2', phone: '12345', dob: birthdayYearsAgo(10) });
    await user.click(screen.getByRole('button', { name: 'Create profile' }));
    expect(await screen.findByText('Names may only contain letters, spaces and . \' -')).toBeInTheDocument();
    expect(screen.getByText('Enter a valid phone number, e.g. +91 98765 43210')).toBeInTheDocument();
    expect(screen.getByText('You must be at least 18 to bank with us')).toBeInTheDocument();
    expect(sent).toHaveLength(0);
  });

  it('requires a date of birth and rejects impossible ages', async () => {
    profileApi(null);
    const { user } = render();
    await fillCreate(user, { dob: '' });
    await user.click(screen.getByRole('button', { name: 'Create profile' }));
    expect(await screen.findByText('Enter your date of birth')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Date of birth'), birthdayYearsAgo(122));
    await user.click(screen.getByRole('button', { name: 'Create profile' }));
    expect(await screen.findByText('Check the year: the date of birth must be within the last 120 years')).toBeInTheDocument();
  });

  it('accepts names with accents, apostrophes and hyphens', async () => {
    const sent = profileApi(null, () => ok(aProfile({ kycStatus: 'PENDING' }), 201));
    const { user } = render();
    await fillCreate(user, { name: 'Zoë  D’Souza-Nair' });
    await user.click(screen.getByRole('button', { name: 'Create profile' }));
    await screen.findByText('Verification in progress');
    expect(sent[0]!.body.fullName).toBe("Zoë D'Souza-Nair");
  });

  it('shows the bank’s field errors next to the right input', async () => {
    profileApi(null, () =>
      fail(400, 'VALIDATION_ERROR', 'Invalid input parameters', { details: [{ field: 'phoneNumber', message: 'Invalid phone number format' }] })
    );
    const { user } = render();
    await fillCreate(user);
    await user.click(screen.getByRole('button', { name: 'Create profile' }));
    expect(await screen.findByText('Invalid phone number format')).toBeInTheDocument();
    expect(screen.getByLabelText('Mobile number')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows a verified identity and saves only what changed', async () => {
    const sent = profileApi(aProfile(), (body) => ok(aProfile({ ...(body as Partial<CustomerProfile>), version: 3 })));
    const { user } = render();
    const status = await screen.findByRole('region', { name: 'Identity verification' });
    expect(within(status).getByText('Identity verified')).toBeInTheDocument();
    const phone = screen.getByLabelText('Mobile number');
    expect(phone).toHaveValue('+919876543210');
    expect(screen.getByLabelText('Date of birth')).toHaveValue('1992-04-12');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await user.clear(phone);
    await user.type(phone, '+91 99999 88888');
    expect(screen.queryByText(/sends your profile back for verification/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Profile updated')).toBeInTheDocument();
    expect(sent).toEqual([{ method: 'PATCH', body: { phoneNumber: '+919999988888' } }]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled());
  });

  it('warns that changing identity details sends the profile back for verification', async () => {
    const sent = profileApi(aProfile());
    const { user } = render();
    const name = await screen.findByLabelText('Full name');
    await user.clear(name);
    await user.type(name, 'Asha R Rao');
    expect(screen.getByText(/sends your profile back for verification/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save and send for verification' }));
    const status = screen.getByRole('region', { name: 'Identity verification' });
    expect(await within(status).findByText('Verification in progress')).toBeInTheDocument();
    expect(sent).toEqual([{ method: 'PATCH', body: { fullName: 'Asha R Rao' } }]);
  });

  it('sends a changed date of birth in the format the bank expects', async () => {
    const sent = profileApi(aProfile());
    const { user } = render();
    const dob = await screen.findByLabelText('Date of birth');
    await user.clear(dob);
    await user.type(dob, '1992-05-12');
    await user.click(screen.getByRole('button', { name: 'Save and send for verification' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toEqual({ dateOfBirth: '1992-05-12T00:00:00.000Z' });
  });

  it('does not let an address be removed', async () => {
    const sent = profileApi(aProfile());
    const { user } = render();
    await user.clear(await screen.findByLabelText(/address/i));
    await user.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByText(/you can change your address, but not remove it/i)).toBeInTheDocument();
    expect(sent).toHaveLength(0);
  });

  it('explains a pending identity check', async () => {
    profileApi(aProfile({ kycStatus: 'PENDING' }));
    render();
    const status = await screen.findByRole('region', { name: 'Identity verification' });
    expect(within(status).getByText('Verification in progress')).toBeInTheDocument();
    expect(status).toHaveTextContent(/you can open accounts once it’s done/i);
  });

  it('explains a rejected identity check and what to do', async () => {
    profileApi(aProfile({ kycStatus: 'REJECTED' }));
    render();
    const status = await screen.findByRole('region', { name: 'Identity verification' });
    expect(within(status).getByText('We couldn’t verify your identity')).toBeInTheDocument();
    expect(status).toHaveTextContent(/contact the bank/i);
  });

  it('shows an error with a retry when the profile cannot be loaded', async () => {
    let calls = 0;
    server.use(
      http.get(apiUrl('/customers/me'), () => {
        calls += 1;
        return calls === 1 ? fail(500, 'INTERNAL_SERVER_ERROR', 'boom') : ok(aProfile());
      })
    );
    const { user } = render();
    await user.click(await screen.findByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Identity verified')).toBeInTheDocument();
  });

  it('shows the sign-in email, which can’t be changed here', async () => {
    profileApi(aProfile());
    render();
    expect(await screen.findByText('asha@example.in')).toBeInTheDocument();
  });
});
