import * as cdk from "aws-cdk-lib/core";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as targets from "aws-cdk-lib/aws-scheduler-targets";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { QueueWithDlq } from "./queueWithDlq";
import { LambdaAlarms } from "./lambdaAlarms";
import { DlqAlarm } from "./dlqAlarm";

export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // SNS topic for alarms
    const alarmTopic = new sns.Topic(this, "AlarmTopic", {
      displayName: "Drazbe AI Alarms",
    });

    alarmTopic.addSubscription(
      new snsSubscriptions.EmailSubscription("marko@strukelj.net"),
    );

    // DynamoDB table to track last trigger times
    const sourceTriggerTable = new dynamodb.TableV2(this, "SourceTriggerTable", {
      partitionKey: { name: "sourceCode", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.NUMBER },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // DynamoDB table for auction data
    const auctionTable = new dynamodb.TableV2(this, "AuctionTable", {
      partitionKey: { name: "auctionId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "recordKey", type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: "ttl",
    });

    // DynamoDB table for tracking visited URLs
    const visitedUrlTable = new dynamodb.TableV2(this, "VisitedUrlTable", {
      partitionKey: { name: "url", type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // SQS queue for source processing
    const sourceQueueWithDlq = new QueueWithDlq(this, "SourceQueue", {
      visibilityTimeoutSeconds: 15 * 60, // 15 minutes
      maxReceiveCount: 1,
      createAlarms: true,
      snsTopicAlarm: alarmTopic,
    });

    // Scheduler Lambda - runs at 18:00 Slovenia time (17:00 UTC in winter, 16:00 UTC in summer)
    const schedulerLambda = new NodejsFunction(this, "SourceScheduler", {
      entry: "backend/events/scheduler.ts",
      timeout: cdk.Duration.minutes(2),
      environment: {
        SOURCE_QUEUE_URL: sourceQueueWithDlq.queue.queueUrl,
        SOURCE_TRIGGER_TABLE_NAME: sourceTriggerTable.tableName,
      },
      memorySize: 512,
    });

    // Grant permissions
    sourceQueueWithDlq.queue.grantSendMessages(schedulerLambda);
    sourceTriggerTable.grantReadWriteData(schedulerLambda);

    // Lambda alarms for scheduler
    new LambdaAlarms(this, "SchedulerAlarms", {
      function: schedulerLambda as any,
      snsTopicAlarm: alarmTopic,
    });

    // EventBridge Scheduler to trigger at 18:00 Slovenia time
    new scheduler.Schedule(this, "SchedulerSchedule", {
      schedule: scheduler.ScheduleExpression.cron({
        minute: "0",
        hour: "18",
        timeZone: cdk.TimeZone.of("Europe/Ljubljana"),
      }),
      target: new targets.LambdaInvoke(schedulerLambda, {}),
    });

    // Source processor Lambda - processes items from queue
    const processorLambda = new NodejsFunction(this, "SourceProcessor", {
      entry: "backend/events/processSource.ts",
      timeout: cdk.Duration.minutes(15),
      memorySize: 2048,
      environment: {
        AUCTION_TABLE_NAME: auctionTable.tableName,
        VISITED_URL_TABLE_NAME: visitedUrlTable.tableName,
      },
    });

    // Grant processor Lambda access to auction table
    auctionTable.grantReadWriteData(processorLambda);

    // Grant processor Lambda access to visited URL table
    visitedUrlTable.grantReadWriteData(processorLambda);

    // Lambda alarms for processor
    new LambdaAlarms(this, "ProcessorAlarms", {
      function: processorLambda as any,
      snsTopicAlarm: alarmTopic,
    });

    // Add SQS trigger to processor Lambda
    processorLambda.addEventSource(
      new lambdaEventSources.SqsEventSource(sourceQueueWithDlq.queue, {
        batchSize: 1, // Process one source at a time
      }),
    );

    // Outputs
    new cdk.CfnOutput(this, "SourceQueueUrl", {
      value: sourceQueueWithDlq.queue.queueUrl,
      description: "Source Queue URL",
    });

    new cdk.CfnOutput(this, "SourceTriggerTableName", {
      value: sourceTriggerTable.tableName,
      description: "Source Trigger Table Name",
    });

    new cdk.CfnOutput(this, "AuctionTableName", {
      value: auctionTable.tableName,
      description: "Auction Table Name",
    });

    new cdk.CfnOutput(this, "VisitedUrlTableName", {
      value: visitedUrlTable.tableName,
      description: "Visited URL Table Name",
    });
  }
}
