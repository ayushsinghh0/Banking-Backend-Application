/**
 * Real-time updates (platform design, sections 8 and 14). The contract between web modules:
 *
 *   <RealtimeProvider>                       mounted once by the authenticated shell
 *   useRealtimeEvent<T>(type, handler)       react to one event type while mounted
 *   useRealtimeStatus()                      'connecting' | 'open' | 'offline'
 */
export { RealtimeProvider, useRealtimeEvent, useRealtimeStatus } from './RealtimeProvider';
export type { RealtimeEnvelope, RealtimeStatus } from './connection';
export type { AccountStatusEvent, FraudAlertRaisedEvent, PayeeAddedEvent, PaymentUpdatedEvent, TransactionPostedEvent } from './events';
