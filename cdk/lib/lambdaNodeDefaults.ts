import { IPropertyInjector, InjectionContext, RemovalPolicy } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import {
  NodejsFunction,
  NodejsFunctionProps,
} from "aws-cdk-lib/aws-lambda-nodejs";

export class LambdaNodeDefaults implements IPropertyInjector {
  public readonly constructUniqueId: string;

  constructor() {
    this.constructUniqueId = NodejsFunction.PROPERTY_INJECTION_ID;
  }

  public inject(
    originalProps: NodejsFunctionProps,
    context: InjectionContext,
  ): NodejsFunctionProps {
    return {
      runtime: lambda.Runtime.NODEJS_22_X,
      logGroup: new logs.LogGroup(context.scope, `${context.id}LogGroup`, {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        "NODE_OPTIONS": "--enable-source-maps",
        ...originalProps.environment,
      },
      memorySize: 1024,
      bundling: {
        sourceMap: true,
        sourcesContent: false,
        ...originalProps.bundling,
      },

      // Include original props to allow overrides
      ...originalProps,
    };
  }
}
