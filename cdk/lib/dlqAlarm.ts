import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as cwactions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as constructs from "constructs";
import * as cdk from "aws-cdk-lib";

export interface DlqAlarmProps {
  readonly deadLetterQueue: sqs.IQueue;
  readonly snsTopicAlarm: sns.ITopic;
}

/**
 * Alarm for messages in DLQ
 */
export class DlqAlarm extends constructs.Construct {
  constructor(scope: constructs.Construct, id: string, props: DlqAlarmProps) {
    super(scope, id);

    const snsActionQlq = new cwactions.SnsAction(props.snsTopicAlarm);

    const deadLetterQueueAlarm = new cloudwatch.Alarm(this, "Alarm", {
      alarmDescription: `Alarm for messages in DLQ ${props.deadLetterQueue.queueName}`,
      metric: props.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.IGNORE,
    });

    deadLetterQueueAlarm.addAlarmAction(snsActionQlq);
    deadLetterQueueAlarm.addOkAction(snsActionQlq);
  }
}
