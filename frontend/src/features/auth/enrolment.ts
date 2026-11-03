/**
 * The staff MFA enrolment token returned by activation lives only in memory for the few seconds between
 * activating and enrolling (never in storage): a reload simply means using the emailed/printed token.
 */
let pendingToken: string | null = null;

export function setEnrolmentToken(token: string | null): void {
  pendingToken = token;
}

export function peekEnrolmentToken(): string | null {
  return pendingToken;
}

export function takeEnrolmentToken(): string | null {
  const token = pendingToken;
  pendingToken = null;
  return token;
}
