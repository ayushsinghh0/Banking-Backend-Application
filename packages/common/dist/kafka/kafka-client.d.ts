import { Producer, Consumer } from 'kafkajs';
export interface KafkaConfig {
    clientId: string;
    brokers: string[];
}
export declare class KafkaService {
    private kafka;
    private producer;
    private consumers;
    constructor(config?: KafkaConfig);
    getProducer(): Promise<Producer>;
    publishEvent(topic: string, key: string, payload: any): Promise<void>;
    subscribe(groupId: string, topics: string[], messageHandler: (topic: string, payload: any, correlationId?: string) => Promise<void>): Promise<Consumer>;
    disconnect(): Promise<void>;
}
//# sourceMappingURL=kafka-client.d.ts.map