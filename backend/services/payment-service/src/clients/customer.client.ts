import { Request } from 'express';
import { HttpError, ServiceClient } from '@banksphere/common';

export type KycStatus = 'PENDING' | 'VERIFIED' | 'REJECTED' | 'NONE';

export interface CustomerApi {
  /** KYC status of the customer; 'NONE' when they have no profile yet */
  getKycStatus(userId: string, context?: Request): Promise<KycStatus>;
}

/** customer-service internal API, authenticated with CUSTOMER_INTERNAL_TOKEN */
export class HttpCustomerClient implements CustomerApi {
  constructor(private readonly client: ServiceClient) {}

  static create(baseUrl: string, internalToken: string): HttpCustomerClient {
    return new HttpCustomerClient(new ServiceClient({ name: 'customer', baseUrl, internalToken, timeoutMs: 3_000 }));
  }

  public async getKycStatus(userId: string, context?: Request): Promise<KycStatus> {
    try {
      const data = await this.client.get<{ kycStatus?: unknown }>(`/internal/v1/customers/${encodeURIComponent(userId)}/kyc`, { context });
      const status = data?.kycStatus;
      if (status === 'PENDING' || status === 'VERIFIED' || status === 'REJECTED') return status;
      throw new HttpError(502, 'BAD_GATEWAY', 'Customer service returned an invalid KYC status');
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 404) return 'NONE';
      throw error;
    }
  }
}
