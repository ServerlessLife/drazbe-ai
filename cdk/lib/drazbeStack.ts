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
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { LambdaErrorSnsSender } from "lambda-error-sns-sender";
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

    alarmTopic.addSubscription(new snsSubscriptions.EmailSubscription("marko@strukelj.net"));

    // Lambda Error SNS Sender - sends detailed Lambda error logs via SNS
    new LambdaErrorSnsSender(this, "LambdaErrorSnsSender", {
      snsTopics: [alarmTopic],
    });

    // SSM Parameters for configuration
    // Note: For sensitive values, update these via AWS Console after deployment
    const openaiApiKeyParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      "OpenAIApiKeyParam",
      {
        parameterName: "/drazbe-ai/openai-api-key",
      }
    );

    const googleMapsApiKeyParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      "GoogleMapsApiKeyParam",
      {
        parameterName: "/drazbe-ai/google-maps-api-key",
      }
    );

    // SSM Parameter for non-sensitive configuration
    const homeAddressParam = new ssm.StringParameter(this, "HomeAddress", {
      parameterName: "/drazbe-ai/home-address",
      stringValue: "Beblerjev trg 3, 1000 Ljubljana, Slovenia",
      description: "Home address for driving distance calculations",
      tier: ssm.ParameterTier.STANDARD,
    });

    // DynamoDB table to track last trigger times
    const sourceTriggerTable = new dynamodb.TableV2(this, "SourceTriggerTable", {
      tableName: "drazbe-source-trigger",
      partitionKey: { name: "sourceCode", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.NUMBER },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // DynamoDB table for auction data with stream for async processing
    const auctionTable = new dynamodb.TableV2(this, "AuctionTable", {
      tableName: "drazbe-auction",
      partitionKey: { name: "auctionId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "recordKey", type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: "ttl",
      dynamoStream: dynamodb.StreamViewType.NEW_IMAGE,
      globalSecondaryIndexes: [
        {
          indexName: "public",
          partitionKey: { name: "gsiPk", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "date", type: dynamodb.AttributeType.STRING },
        },
      ],
    });

    // DynamoDB table for tracking visited URLs
    const visitedUrlTable = new dynamodb.TableV2(this, "VisitedUrlTable", {
      tableName: "drazbe-visited-url",
      partitionKey: { name: "dataSourceCode", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "url", type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // DynamoDB table for user-specific auction suitability
    const userSuitabilityTable = new dynamodb.TableV2(this, "UserSuitabilityTable", {
      tableName: "drazbe-user-suitability",
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "auctionId", type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // S3 bucket for files (images, documents) - accessed via CloudFront
    const contentBucket = new s3.Bucket(this, "ContentBucket", {
      bucketName: "drazbe-ai-content",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
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
      entry: "../backend/events/scheduler.ts",
      timeout: cdk.Duration.minutes(2),
      environment: {
        SOURCE_QUEUE_URL: sourceQueueWithDlq.queue.queueUrl,
        SOURCE_TRIGGER_TABLE_NAME: sourceTriggerTable.tableName,
        NODE_OPTIONS: "--enable-source-maps",
      },
      memorySize: 512,
      bundling: {
        sourceMap: true,
        sourcesContent: false,
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir, outputDir) => [
            `cp ${inputDir}/backend/sources.json ${outputDir}/`,
          ],
        },
      },
    });

    // Grant permissions
    sourceQueueWithDlq.queue.grantSendMessages(schedulerLambda);
    sourceTriggerTable.grantReadWriteData(schedulerLambda);

    // Lambda alarms for scheduler
    new LambdaAlarms(this, "SchedulerAlarms", {
      function: schedulerLambda as any,
      snsTopicAlarm: alarmTopic,
    });

    /*
    // EventBridge Scheduler to trigger processing
    new scheduler.Schedule(this, "SchedulerSchedule", {
      //  schedule: scheduler.ScheduleExpression.cron({
      //   minute: "0",
      //   hour: "18",
      //   timeZone: cdk.TimeZone.of("Europe/Ljubljana"),
      // }),
      schedule: scheduler.ScheduleExpression.rate(cdk.Duration.minutes(30)),
      target: new targets.LambdaInvoke(schedulerLambda, {}),
    });
    */

    // Source processor Lambda - processes items from queue
    const processorLambda = new NodejsFunction(this, "DataSourceProcessor", {
      entry: "../backend/events/processDataSource.ts",
      timeout: cdk.Duration.minutes(15),
      memorySize: 2048,
      environment: {
        AUCTION_TABLE_NAME: auctionTable.tableName,
        VISITED_URL_TABLE_NAME: visitedUrlTable.tableName,
        PUBLIC_BUCKET_NAME: contentBucket.bucketName,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        sourceMap: true,
        sourcesContent: false,
        externalModules: [
          "playwright",
          "playwright-core",
          "@sparticuz/chromium",
          "canvas",
          "chromium-bidi",
          "tesseract.js",
        ],
        nodeModules: [
          "playwright",
          "playwright-core",
          "@sparticuz/chromium",
          "canvas",
          "chromium-bidi",
          "tesseract.js",
        ],
      },
    });

    // Grant processor Lambda access to auction table
    auctionTable.grantReadWriteData(processorLambda);

    // Grant processor Lambda access to visited URL table
    visitedUrlTable.grantReadWriteData(processorLambda);

    // Grant processor Lambda access to S3 bucket for documents
    contentBucket.grantReadWrite(processorLambda);

    // Grant processor Lambda access to SSM parameters
    openaiApiKeyParam.grantRead(processorLambda);

    // Lambda alarms for processor
    new LambdaAlarms(this, "ProcessorAlarms", {
      function: processorLambda as any,
      snsTopicAlarm: alarmTopic,
    });

    // Add SQS trigger to processor Lambda
    processorLambda.addEventSource(
      new lambdaEventSources.SqsEventSource(sourceQueueWithDlq.queue, {
        batchSize: 1, // Process one source at a time
      })
    );

    // SQS queue for auction AI analysis (triggered by DynamoDB stream)
    const auctionAnalysisQueueWithDlq = new QueueWithDlq(this, "AuctionAnalysisQueue", {
      visibilityTimeoutSeconds: 2 * 60, // 2 minutes
      maxReceiveCount: 3,
      createAlarms: true,
      snsTopicAlarm: alarmTopic,
    });

    // Stream processor Lambda - routes DynamoDB stream events to appropriate queues and handles cleanup
    const streamProcessorLambda = new NodejsFunction(this, "StreamProcessor", {
      entry: "../backend/events/processStream.ts",
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        AUCTION_ANALYSIS_QUEUE_URL: auctionAnalysisQueueWithDlq.queue.queueUrl,
        CONTENT_BUCKET_NAME: contentBucket.bucketName,
      },
      bundling: {
        sourceMap: true,
        sourcesContent: false,
      },
    });

    // Grant stream processor Lambda permissions to send messages to queues
    auctionAnalysisQueueWithDlq.queue.grantSendMessages(streamProcessorLambda);

    // Grant stream processor Lambda permissions to delete from S3 bucket
    contentBucket.grantDelete(streamProcessorLambda);

    // Add DynamoDB stream trigger to stream processor with filter
    streamProcessorLambda.addEventSource(
      new lambdaEventSources.DynamoEventSource(auctionTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        retryAttempts: 3,
        filters: [
          // Process INSERT events for MAIN record types
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual("INSERT"),
            dynamodb: {
              NewImage: {
                recordType: {
                  S: lambda.FilterRule.isEqual("MAIN"),
                },
              },
            },
          }),
          // Process REMOVE events for PROPERTY or DOCUMENT record types (cleanup S3 files)
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual("REMOVE"),
            dynamodb: {
              OldImage: {
                recordType: {
                  S: lambda.FilterRule.or("PROPERTY", "DOCUMENT"),
                },
              },
            },
          }),
        ],
      })
    );

    // Lambda alarms for stream processor
    new LambdaAlarms(this, "StreamProcessorAlarms", {
      function: streamProcessorLambda as any,
      snsTopicAlarm: alarmTopic,
    });

    // Auction AI analysis processor Lambda
    const auctionAnalysisProcessorLambda = new NodejsFunction(this, "AuctionAnalysisProcessor", {
      entry: "../backend/events/processAuctionAnalysis.ts",
      timeout: cdk.Duration.minutes(2),
      environment: {
        AUCTION_TABLE_NAME: auctionTable.tableName,
        USER_SUITABILITY_TABLE_NAME: userSuitabilityTable.tableName,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        sourceMap: true,
        sourcesContent: false,
      },
    });

    // Grant auction analysis processor Lambda access to auction table
    auctionTable.grantReadWriteData(auctionAnalysisProcessorLambda);

    // Grant auction analysis processor Lambda access to user suitability table
    userSuitabilityTable.grantReadWriteData(auctionAnalysisProcessorLambda);

    // Grant auction analysis processor Lambda access to SSM parameters
    openaiApiKeyParam.grantRead(auctionAnalysisProcessorLambda);
    googleMapsApiKeyParam.grantRead(auctionAnalysisProcessorLambda);
    homeAddressParam.grantRead(auctionAnalysisProcessorLambda);

    // Add SQS trigger to auction analysis processor Lambda
    auctionAnalysisProcessorLambda.addEventSource(
      new lambdaEventSources.SqsEventSource(auctionAnalysisQueueWithDlq.queue, {
        batchSize: 1,
      })
    );

    // Lambda alarms for auction analysis processor
    new LambdaAlarms(this, "AuctionAnalysisProcessorAlarms", {
      function: auctionAnalysisProcessorLambda as any,
      snsTopicAlarm: alarmTopic,
    });

    // RSS Feed Lambda with Function URL
    const rssFeedLambda = new NodejsFunction(this, "RssFeedLambda", {
      entry: "../backend/events/rssFeed.ts",
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        AUCTION_TABLE_NAME: auctionTable.tableName,
        USER_SUITABILITY_TABLE_NAME: userSuitabilityTable.tableName,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        sourceMap: true,
        sourcesContent: false,
      },
    });

    // Grant RSS Lambda read access to tables
    auctionTable.grantReadData(rssFeedLambda);
    userSuitabilityTable.grantReadData(rssFeedLambda);

    // Create Lambda Function URL for RSS feed
    const rssFunctionUrl = rssFeedLambda.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // CloudFront distribution
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: new origins.S3StaticWebsiteOrigin(contentBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        "/images/*": {
          origin: origins.S3BucketOrigin.withOriginAccessControl(contentBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
        "/documents/*": {
          origin: origins.S3BucketOrigin.withOriginAccessControl(contentBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
        "/rss": {
          origin: new origins.FunctionUrlOrigin(rssFunctionUrl),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        },
      },
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

    new cdk.CfnOutput(this, "ContentBucketName", {
      value: contentBucket.bucketName,
      description: "Content S3 Bucket Name",
    });

    new cdk.CfnOutput(this, "CloudFrontDistributionUrl", {
      value: `https://${distribution.distributionDomainName}`,
      description: "CloudFront Distribution URL",
    });

    new cdk.CfnOutput(this, "RssFeedUrl", {
      value: `https://${distribution.distributionDomainName}/rss`,
      description: "RSS Feed URL",
    });
  }
}
