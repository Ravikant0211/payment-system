import { Kafka, logLevel } from 'kafkajs';
import { kafkaConfig } from '@/config';

let kafka: Kafka | null = null;

export function getKafkaClient(): Kafka {
  if (!kafka) {
    kafka = new Kafka({
      clientId: kafkaConfig.clientId,
      brokers: kafkaConfig.brokers,
      ssl: kafkaConfig.ssl,
      // Map pino log levels to KafkaJS log levels
      logLevel: logLevel.WARN,
      retry: {
        initialRetryTime: 300,
        retries: 10,
      },
    });
  }
  return kafka;
}
