/**
 * Message sent to the Source SQS Queue.
 * Contains only the source code - the processor reads full details from sources.json
 */
export interface SourceQueueMessage {
  code: string;
}
