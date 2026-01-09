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

    // DynamoDB table for auction data with stream for async processing
    const auctionTable = new dynamodb.TableV2(this, "AuctionTable", {
      partitionKey: { name: "auctionId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "recordKey", type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: "ttl",
      dynamoStream: dynamodb.StreamViewType.NEW_IMAGE,
    });

    // DynamoDB table for tracking visited URLs
    const visitedUrlTable = new dynamodb.TableV2(this, "VisitedUrlTable", {
      partitionKey: { name: "url", type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // DynamoDB table for user-specific auction suitability
    const userSuitabilityTable = new dynamodb.TableV2(this, "UserSuitabilityTable", {
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "auctionId", type: dynamodb.AttributeType.STRING },
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

    // SQS queue for property screenshot processing (triggered by DynamoDB stream)
    const propertyQueueWithDlq = new QueueWithDlq(this, "PropertyQueue", {
      visibilityTimeoutSeconds: 5 * 60, // 5 minutes
      maxReceiveCount: 3,
      createAlarms: true,
      snsTopicAlarm: alarmTopic,
    });

    // SQS queue for auction AI analysis (triggered by DynamoDB stream)
    const auctionAnalysisQueueWithDlq = new QueueWithDlq(this, "AuctionAnalysisQueue", {
      visibilityTimeoutSeconds: 2 * 60, // 2 minutes
      maxReceiveCount: 3,
      createAlarms: true,
      snsTopicAlarm: alarmTopic,
    });

    // Stream processor Lambda - routes DynamoDB stream events to appropriate queues
    const streamProcessorLambda = new NodejsFunction(this, "StreamProcessor", {
      entry: "backend/events/processStream.ts",
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        PROPERTY_QUEUE_URL: propertyQueueWithDlq.queue.queueUrl,
        AUCTION_ANALYSIS_QUEUE_URL: auctionAnalysisQueueWithDlq.queue.queueUrl,
      },
    });

    // Grant stream processor Lambda permissions to send messages to queues
    propertyQueueWithDlq.queue.grantSendMessages(streamProcessorLambda);
    auctionAnalysisQueueWithDlq.queue.grantSendMessages(streamProcessorLambda);

    // Add DynamoDB stream trigger to stream processor with filter
    streamProcessorLambda.addEventSource(
      new lambdaEventSources.DynamoEventSource(auctionTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        retryAttempts: 3,
        filters: [
          // Only process INSERT events for PROPERTY or MAIN record types
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual("INSERT"),
            dynamodb: {
              NewImage: {
                recordType: {
                  S: lambda.FilterRule.or("PROPERTY", "MAIN"),
                },
              },
            },
          }),
        ],
      }),
    );

    // Lambda alarms for stream processor
    new LambdaAlarms(this, "StreamProcessorAlarms", {
      function: streamProcessorLambda as any,
      snsTopicAlarm: alarmTopic,
    });

    // Property screenshot processor Lambda
    const propertyProcessorLambda = new NodejsFunction(this, "PropertyProcessor", {
      entry: "backend/events/processProperty.ts",
      timeout: cdk.Duration.minutes(5),
      memorySize: 2048,
      environment: {
        AUCTION_TABLE_NAME: auctionTable.tableName,
      },
    });

    // Grant property processor Lambda access to auction table
    auctionTable.grantReadWriteData(propertyProcessorLambda);

    // Add SQS trigger to property processor Lambda
    propertyProcessorLambda.addEventSource(
      new lambdaEventSources.SqsEventSource(propertyQueueWithDlq.queue, {
        batchSize: 1,
      }),
    );

    // Lambda alarms for property processor
    new LambdaAlarms(this, "PropertyProcessorAlarms", {
      function: propertyProcessorLambda as any,
      snsTopicAlarm: alarmTopic,
    });

    // Auction AI analysis processor Lambda
    const auctionAnalysisProcessorLambda = new NodejsFunction(this, "AuctionAnalysisProcessor", {
      entry: "backend/events/processAuctionAnalysis.ts",
      timeout: cdk.Duration.minutes(2),
      environment: {
        AUCTION_TABLE_NAME: auctionTable.tableName,
        USER_SUITABILITY_TABLE_NAME: userSuitabilityTable.tableName,
        HOME_ADDRESS: "Beblerjev trg 3, 1000 Ljubljana, Slovenia",
        // TODO: Store GOOGLE_MAPS_API_KEY in SSM Parameter Store or Secrets Manager
        GOOGLE_MAPS_API_KEY: "",
      },
    });

    // Grant auction analysis processor Lambda access to auction table
    auctionTable.grantReadWriteData(auctionAnalysisProcessorLambda);

    // Grant auction analysis processor Lambda access to user suitability table
    userSuitabilityTable.grantReadWriteData(auctionAnalysisProcessorLambda);

    // Add SQS trigger to auction analysis processor Lambda
    auctionAnalysisProcessorLambda.addEventSource(
      new lambdaEventSources.SqsEventSource(auctionAnalysisQueueWithDlq.queue, {
        batchSize: 1,
      }),
    );

    // Lambda alarms for auction analysis processor
    new LambdaAlarms(this, "AuctionAnalysisProcessorAlarms", {
      function: auctionAnalysisProcessorLambda as any,
      snsTopicAlarm: alarmTopic,
    });

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

    new cdk.CfnOutput(this, "UserSuitabilityTableName", {
      value: userSuitabilityTable.tableName,
      description: "User Suitability Table Name",
    });
  }
}
