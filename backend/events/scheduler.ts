import { SchedulerService } from "../services/SchedulerService.js";

interface SchedulerEvent {
  time: string;
}

/**
 * Scheduler Lambda - Runs every 30 minutes
 * Checks which sources need to be triggered based on their schedule
 * When batching is enabled, processes only the oldest N sources per run
 */
export async function handler(event: SchedulerEvent) {
  const result = await SchedulerService.processScheduledSources();

  return {
    statusCode: 200,
    body: `Scheduler completed. Processed ${result.processed} of ${result.total} eligible sources.`,
  };
}
