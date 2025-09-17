import * as cdk from 'aws-cdk-lib';
import { Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { Construct } from 'constructs';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';

interface CustomStackProps extends cdk.StackProps {
  githubUser: string;
  githubRepo: string;
  githubTokenSecretArn: string;
}

export class CdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: CustomStackProps) {
    super(scope, id, props);

    console.log('props:', props);
    // --------------------------
    // ECR Repository for Node Build Image
    // --------------------------
    const nodeEcrRepo = new ecr.Repository(this, 'NodeBuildRepo', {
      removalPolicy: RemovalPolicy.DESTROY,
      repositoryName: 'vite-node-build-image',
    });

    // S3 bucket for deployment
    const deployBucket = new s3.Bucket(this, 'ViteDeployBucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CloudFront distribution
    const distribution = new cloudfront.Distribution(this, 'ViteDistribution', {
      defaultBehavior: { origin: origins.S3BucketOrigin.withOriginAccessControl(deployBucket) },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
      ],
    });

    // Add bucket policy to allow CloudFront access
    deployBucket.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [deployBucket.arnForObjects('*')],
      principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
      conditions: {
        StringEquals: {
          'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
        },
      },
    }));

    // --------------------------
    // CodeBuild Project for Docker Image Build
    // --------------------------
    const dockerBuildProject = new codebuild.PipelineProject(this, 'DockerBuildProject', {
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        
        phases: {
          pre_build: {
            commands: [
              'if git rev-parse --quiet --verify HEAD~1 >/dev/null 2>&1; then if git diff --quiet HEAD~1 -- package.json pnpm-lock.yaml; then export SKIP_DOCKER_BUILD=true; else export SKIP_DOCKER_BUILD=false; fi; else export SKIP_DOCKER_BUILD=false; fi',
              'echo "SKIP_DOCKER_BUILD is $SKIP_DOCKER_BUILD"',
              'echo Logging in to Amazon ECR...',
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin ' + nodeEcrRepo.repositoryUri,
              'docker pull ' + nodeEcrRepo.repositoryUri + ':latest || true',
            ],
          },
          build: {
            commands: [
              'if [ "$SKIP_DOCKER_BUILD" = "true" ]; then echo "Skipping Docker build as package.json and pnpm-lock.yaml have not changed."; else echo "Building Docker image..."; docker build --cache-from ' + nodeEcrRepo.repositoryUri + ':latest -t vite-node-build:latest -f ./cdk/lib/build-image-dockerfile/Dockerfile .; docker tag vite-node-build:latest ' + nodeEcrRepo.repositoryUri + ':latest; fi',
            ],
          },
          post_build: {
            commands: [
              'if [ "$SKIP_DOCKER_BUILD" = "true" ]; then echo "Skipping Docker push as package.json and pnpm-lock.yaml have not changed."; else echo "Pushing Docker image..."; docker push ' + nodeEcrRepo.repositoryUri + ':latest; fi',
            ],
          },
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_6_0,
        privileged: true, // required for Docker
      },
    });

    nodeEcrRepo.grantPullPush(dockerBuildProject.role!);

    // --------------------------
    // CodeBuild Project for Vite App Build
    // --------------------------
    const viteBuildProject = new codebuild.PipelineProject(this, 'ViteBuildProject', {
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: [
              'echo Using prebuilt Node Docker image...',
            ],
          },
          build: {
            commands: [
              'pnpm install --frozen-lockfile',
              'pnpm run build',
            ],
          },
        },
        artifacts: {
          'base-directory': 'dist',
          files: ['**/*'],
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.fromEcrRepository(nodeEcrRepo, 'latest'),
        privileged: true,
      },
    });

    // --------------------------
    // Lambda for CloudFront Invalidation
    // --------------------------
    const invalidateLambda = new lambda.Function(this, 'CloudFrontInvalidatorLambda', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'cloudfront-invalidator.handler',
      code: lambda.Code.fromAsset('./lib/lambda/'),
      environment: {
        CLOUDFRONT_DISTRIBUTION_ID: distribution.distributionId,
      },
    });

    // Grant the Lambda function permissions to invalidate CloudFront and interact with CodePipeline
    invalidateLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cloudfront:CreateInvalidation',
        'cloudfront:GetInvalidation',
        'codepipeline:PutJobSuccessResult',
        'codepipeline:PutJobFailureResult',
      ],
      resources: [
        `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
        `arn:aws:codepipeline:${this.region}:${this.account}:*`, // Grant access to all pipelines in the account/region
      ],
    }));

    // --------------------------
    // Unified Pipeline: Build Docker Image & Deploy Vite App
    // --------------------------
    const sourceOutput = new codepipeline.Artifact();

    const unifiedPipeline = new codepipeline.Pipeline(this, 'UnifiedWebAppPipeline', {
      pipelineType: codepipeline.PipelineType.V1,
      pipelineName: 'WebAppCDPipeline',
      restartExecutionOnUpdate: true,
    });

    unifiedPipeline.addStage({
      stageName: 'Source',
      actions: [
        new codepipeline_actions.GitHubSourceAction({
          actionName: 'GitHub_Source',
          owner: props?.githubUser!,
          repo: props?.githubRepo!,
          branch: 'main', // Trigger on pushes to the main branch
          oauthToken: cdk.SecretValue.secretsManager(props?.githubTokenSecretArn!),
          output: sourceOutput,
          trigger: codepipeline_actions.GitHubTrigger.WEBHOOK, // Use WEBHOOK for AWS
        }),
      ],
    });

    unifiedPipeline.addStage({
      stageName: 'DockerBuild',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'Docker_Build_And_Push',
          project: dockerBuildProject,
          input: sourceOutput,
          outputs: [], // No output artifact needed, as it pushes to ECR
        }),
      ],
    });

    unifiedPipeline.addStage({
      stageName: 'ViteBuild',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'Vite_Build',
          project: viteBuildProject,
          input: sourceOutput,
          outputs: [new codepipeline.Artifact('ViteBuildOutput')],
        }),
      ],
    });

    unifiedPipeline.addStage({
      stageName: 'Deploy',
      actions: [
        new codepipeline_actions.S3DeployAction({
          actionName: 'S3_Deploy',
          bucket: deployBucket,
          input: new codepipeline.Artifact('ViteBuildOutput'),
        }),
        new codepipeline_actions.LambdaInvokeAction({
          actionName: 'Invalidate_CloudFront',
          lambda: invalidateLambda,
          // No inputs or outputs needed as the Lambda directly interacts with CloudFront
        }),
      ],
    });
  }
}
