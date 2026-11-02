import { counter, gauge } from '@banksphere/common';

export const realtimeMetrics = {
  connections: gauge('realtime_connections', 'Open real-time streams on this replica'),
  delivered: counter('realtime_events_delivered_total', 'Events written to client streams (live and replayed)', ['type']),
  published: counter('realtime_events_published_total', 'Events published to Redis by the Kafka consumer, per recipient channel', ['type']),
  replayed: counter('realtime_replayed_events_total', 'Events re-sent from the replay log after a reconnect (Last-Event-ID)'),
  rejected: counter('realtime_streams_rejected_total', 'Stream requests refused', ['reason']),
  closed: counter('realtime_streams_closed_total', 'Streams ended, by reason', ['reason']),
  skipped: counter('realtime_kafka_events_skipped_total', 'Kafka events not turned into real-time events', ['reason']),
};
