import { Queue, Worker, type Processor } from "bullmq";
import IORedis from "ioredis";

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL environment variable is required");
}

export const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const QUEUE_NAMES = {
  RESULT_REFRESH: "result-refresh",
} as const;

export function createQueue(name: string) {
  return new Queue(name, { connection });
}

export function createWorker<T = unknown, R = unknown>(
  name: string,
  processor: Processor<T, R>
) {
  return new Worker<T, R>(name, processor, {
    connection,
    concurrency: 5,
  });
}
