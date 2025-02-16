import { Construct } from 'constructs';
import { IUserPool, IUserPoolClient } from 'aws-cdk-lib/aws-cognito';
import { Rule, Match } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { AuthConstruct } from '../frontend/auth-construct';
import { ApiConstruct } from './api-construct';
import { FunctionsConstruct } from './functions-construct';
import { StorageConstruct } from './storage-construct';
import { SSMParameterStoreConstruct } from '../shared/ssm/ssm-parameter-store-construct';

class ContentHubRepoProps {
  userPool: IUserPool;
  landingZoneBucketName: string;
}

export class ContentHubRepo extends Construct {
  public readonly storage: StorageConstruct;
  public readonly auth: AuthConstruct;
  public readonly api: ApiConstruct;
  public readonly functions: FunctionsConstruct;
  public readonly ssmParameterStore: SSMParameterStoreConstruct;

  constructor(scope: Construct, id: string, props: ContentHubRepoProps) {
    super(scope, id);

    const { landingZoneBucketName, userPool } = props;

    this.storage = new StorageConstruct(this, 'storage-construct', {
      landingZoneBucketName,
    });

    this.functions = new FunctionsConstruct(this, 'functions-construct', {
      landingZoneBucketName: this.storage.landingZoneBucket.bucketName,
    });

    this.storage.grantReadWriteDataOnTable(
      this.functions.getPresignedUploadUrlFn
    );
    this.storage.grantPutOnBucket(this.functions.getPresignedUploadUrlFn);
    this.storage.grantReadDataOnTable(this.functions.getPresignedDownloadUrlFn);
    this.storage.grantGetOnBucket(this.functions.getPresignedDownloadUrlFn);

    this.api = new ApiConstruct(this, 'api-construct', {
      getPresignedUploadUrlFn: this.functions.getPresignedUploadUrlFn,
      getPresignedDownloadUrlFn: this.functions.getPresignedDownloadUrlFn,
      userPool: userPool,
      table: this.storage.filesTable,
    });
    this.api.api.grantMutation(
      this.functions.markCompleteUploadFn,
      'updateFileStatus'
    );
    this.functions.markCompleteUploadFn.addEnvironment(
      'APPSYNC_ENDPOINT',
      `https://${this.api.domain}/graphql`
    );

    const uploadedRule = new Rule(this, 'new-uploads', {
      eventPattern: {
        source: Match.anyOf('aws.s3'),
        detailType: Match.anyOf('Object Created'),
        detail: {
          bucket: {
            name: Match.anyOf(this.storage.landingZoneBucket.bucketName),
          },
          object: { key: Match.prefix('uploads/') },
          reason: Match.anyOf('PutObject'),
        },
      },
    });
    uploadedRule.addTarget(
      new LambdaFunction(this.functions.markCompleteUploadFn)
    );

    this.ssmParameterStore = new SSMParameterStoreConstruct(this, 'content-hub-repository-parameter', {
      failureMode: 'denylist',
      nodeJSLambdaFunction: this.functions.getPresignedUploadUrlFn
    });

    this.functions.getPresignedUploadUrlFn.addEnvironment(
      'FAILURE_INJECTION_PARAM',
      this.ssmParameterStore.ssmParameterStore.parameterName
    );

    this.ssmParameterStore.ssmParameterStore.grantRead(this.functions.getPresignedUploadUrlFn);
  }
}
