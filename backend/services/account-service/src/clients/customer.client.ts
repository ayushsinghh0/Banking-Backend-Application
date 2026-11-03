import {
  BadGatewayError,
  INTERNAL_TOKEN_HEADER,
  getInternalToken,
} from '@banksphere/common';

export type KycStatus = 'PENDING' | 'VERIFIED' | 'REJECTED';

export interface CustomerClient {
  getKycStatus(userId: string): Promise<KycStatus>;
}

/**
 * Internal client for customer-service, used to gate account opening on a verified KYC.
 */
export class HttpCustomerClient implements CustomerClient {
  constructor(
    private readonly baseUrl = process.env.CUSTOMER_SERVICE_URL || 'http://localhost:8002',
    private readonly timeoutMs = 5000
  ) {}

  public async getKycStatus(userId: string): Promise<KycStatus> {
    let response: globalThis.Response;
    try {
      response = await fetch(`${this.baseUrl}/internal/v1/customers/${encodeURIComponent(userId)}/kyc`, {
        headers: { [INTERNAL_TOKEN_HEADER]: getInternalToken('CUSTOMER_INTERNAL_TOKEN') },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new BadGatewayError('Customer service is unreachable');
    }
    if (!response.ok) {
      throw new BadGatewayError(`Customer service rejected the request (HTTP ${response.status})`);
    }
    const body = (await response.json()) as { data?: { kycStatus?: KycStatus } };
    const status = body.data?.kycStatus;
    if (status !== 'PENDING' && status !== 'VERIFIED' && status !== 'REJECTED') {
      throw new BadGatewayError('Customer service returned an invalid KYC status');
    }
    return status;
  }
}
