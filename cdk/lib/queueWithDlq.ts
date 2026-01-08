import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as cdk from "aws-cdk-lib";
import * as constructs from "constructs";
import { DlqAlarm } from "./dlqAlarm";

export interface QueueWithDlqProps {
  readonly alarmWhenMessageOlderThanSeconds?: number;
  readonly snsTopicAlarm?: sns.ITopic;
  readonly createAlarms: boolean;
  readonly receiveMessageWaitTimeSeconds?: number;
  readonly maxReceiveCount: number;
  readonly visibilityTimeoutSeconds: number;
}

/**
 * Queue with dead letter queue for messages that could not be processed
 */
export class QueueWithDlq extends constructs.Construct {
  public readonly queue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;

  constructor(
    scope: constructs.Construct,
    id: string,
    props: QueueWithDlqProps,
  ) {
    super(scope, id);

    this.deadLetterQueue = new sqs.Queue(this, "Dlq", {
      retentionPeriod: cdk.Duration.days(14),
    });
    this.queue = new sqs.Queue(this, "Queue", {
      retentionPeriod: cdk.Duration.days(14),
      receiveMessageWaitTime: props.receiveMessageWaitTimeSeconds
        ? cdk.Duration.seconds(props.receiveMessageWaitTimeSeconds)
        : undefined,
      deadLetterQueue: {
        maxReceiveCount: props.maxReceiveCount,
        queue: this.deadLetterQueue,
      },
      visibilityTimeout: cdk.Duration.seconds(props.visibilityTimeoutSeconds),
    });

    if (props.createAlarms && props.snsTopicAlarm) {
      // const snsActionQueue = new cwactions.SnsAction(props.snsTopicAlarm);

      // if (props.alarmWhenMessageOlderThanSeconds) {
      //   const queueAlarm = new cloudwatch.Alarm(this, "QueueAlarm", {
      //     alarmDescription: `Alarm for old messages in the queue ${this.queue.queueName}`,
      //     metric: this.queue.metricApproximateAgeOfOldestMessage({
      //       period: cdk.Duration.minutes(1),
      //     }),
      //     threshold: props.alarmWhenMessageOlderThanSeconds,
      //     evaluationPeriods: 1,
      //     comparisonOperator:
      //       cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      //     treatMissingData: cloudwatch.TreatMissingData.IGNORE,
      //   });
      //   queueAlarm.addAlarmAction(snsActionQueue);
      //   queueAlarm.addOkAction(snsActionQueue);
      // }

      new DlqAlarm(this, "DlqAlarm", {
        deadLetterQueue: this.deadLetterQueue,
        snsTopicAlarm: props.snsTopicAlarm,
      });
    }
  }
}
