import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwactions from "aws-cdk-lib/aws-cloudwatch-actions";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import type * as sns from "aws-cdk-lib/aws-sns";
import * as constructs from "constructs";

export interface LambdaAlarmsProps {
  readonly function: lambda.Function;
  readonly snsTopicAlarm: sns.ITopic;
  readonly errorThreshold?: number;
  readonly errorPeriod?: number;
  readonly errorEvaluationPeriods?: number;
  readonly errorDatapointsToAlarm?: number;
  readonly throttlesThreshold?: number;
  readonly throttlesPeriod?: number;
  readonly throttlesEvaluationPeriods?: number;
  readonly throttlesDatapointsToAlarm?: number;
  readonly durationPeriod?: number;
  readonly durationEvaluationPeriods?: number;
  readonly durationDatapointsToAlarm?: number;
}

/**
 * Alarms for Lambda function
 */
export class LambdaAlarms extends constructs.Construct {
  constructor(
    scope: constructs.Construct,
    id: string,
    props: LambdaAlarmsProps,
  ) {
    super(scope, id);

    // alarm for errors
    const functionErrorsMetric = props.function.metricErrors({
      period: cdk.Duration.minutes(props.errorPeriod ?? 1),
    });

    const alarmFunctionErrors = functionErrorsMetric.createAlarm(
      this,
      "LambdaErrorsAlarm",
      {
        threshold: props.errorThreshold ?? 0,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: props.errorEvaluationPeriods ?? 1,
        datapointsToAlarm: props.errorDatapointsToAlarm ?? 1,
        alarmDescription: "Over 0 errors per minute",
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    alarmFunctionErrors.addAlarmAction(
      new cwactions.SnsAction(props.snsTopicAlarm),
    );
    alarmFunctionErrors.addOkAction(
      new cwactions.SnsAction(props.snsTopicAlarm),
    );

    // alarm for throttles
    const functionThrottlesMetric = props.function.metricThrottles({
      period: cdk.Duration.minutes(props.throttlesPeriod ?? 1),
    });

    // const alarmFunctionThrottles = functionThrottlesMetric.createAlarm(
    //   this,
    //   "LambdaThrottlesAlarm",
    //   {
    //     threshold: props.throttlesThreshold ?? 0,
    //     comparisonOperator:
    //       cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    //     evaluationPeriods: props.throttlesEvaluationPeriods ?? 1,
    //     datapointsToAlarm: props.throttlesDatapointsToAlarm ?? 1,
    //     alarmDescription: "Over 0 throttles per minute",
    //     treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    //   },
    // );
    // alarmFunctionThrottles.addAlarmAction(
    //   new cwactions.SnsAction(props.snsTopicAlarm),
    // );
    // alarmFunctionThrottles.addOkAction(
    //   new cwactions.SnsAction(props.snsTopicAlarm),
    // );

    // alarm for timeout
    const timeoutSec =
      (props.function.node.defaultChild as lambda.CfnFunction).timeout ?? 3;
    const functionDuration = props.function.metricDuration({
      period: cdk.Duration.minutes(props.durationPeriod ?? 1),
      label: "p99",
      statistic: "p99",
    });
    const durationPercentThreshold = 80;
    const durationThresholdSec = Math.floor(
      (durationPercentThreshold / 100) * timeoutSec,
    );

    const alarmFunctionDurationMetric = functionDuration.createAlarm(
      this,
      "LambdaDurationAlarm",
      {
        threshold: durationThresholdSec * 1000, // milliseconds,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: props.durationEvaluationPeriods ?? 1,
        datapointsToAlarm: props.durationDatapointsToAlarm ?? 1,
        alarmDescription: `p99 latency >= ${durationThresholdSec}s (${durationPercentThreshold}%)`,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );

    alarmFunctionDurationMetric.addAlarmAction(
      new cwactions.SnsAction(props.snsTopicAlarm),
    );
    alarmFunctionDurationMetric.addOkAction(
      new cwactions.SnsAction(props.snsTopicAlarm),
    );
  }
}
