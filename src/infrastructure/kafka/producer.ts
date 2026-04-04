import { Producer, Message } from 'kafkajs';
import { getKafkaClient } from './kafka-client';
import { logger } from '@/common/logger/logger';
import { getTraceContext } from '@/common/tracing/trace-context';
import { metrics } from '@/metrics/metrics';

let producer: Producer | null = null;
let isConnected = false;

export async function getProducer(): Promise<Producer> {
  if (!producer) {
    producer = getKafkaClient().producer({
      idempotent: true,          // Kafka-level exactly-once within a partition
      maxInFlightRequests: 5,
      transactionTimeout: 30_000,
    });
  }
  if (!isConnected) {
    await producer.connect();
    isConnected = true;
    logger.info('Kafka producer connected');
  }
  return producer;
}

export interface KafkaMessage<T = unknown> {
  topic: string;
  key?: string;
  value: T;
  headers?: Record<string, string>;
}

export async function sendMessage<T>(msg: KafkaMessage<T>): Promise<void> {
  const ctx = getTraceContext();
  const prod = await getProducer();
  const timer = metrics.kafkaProducerDuration.startTimer({ topic: msg.topic });

  const kafkaMsg: Message = {
    key: msg.key ?? null,
    value: JSON.stringify(msg.value),
    headers: {
      traceId: ctx?.traceId ?? '',
      correlationId: ctx?.correlationId ?? '',
      timestamp: new Date().toISOString(),
      ...msg.headers,
    },
  };

  try {
    await prod.send({ topic: msg.topic, messages: [kafkaMsg] });
    timer({ result: 'success' });
    logger.debug({ topic: msg.topic, key: msg.key }, 'Kafka message sent');
  } catch (err) {
    timer({ result: 'error' });
    logger.error({ err, topic: msg.topic }, 'Failed to send Kafka message');
    throw err;
  }
}

export async function disconnectProducer(): Promise<void> {
  if (producer && isConnected) {
    await producer.disconnect();
    isConnected = false;
    producer = null;
    logger.info('Kafka producer disconnected');
  }
}
