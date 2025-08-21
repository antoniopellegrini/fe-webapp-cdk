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
import * as cpactions from 'aws-cdk-lib/aws-codepipeline-actions';

interface CustomStackProps extends cdk.StackProps {
  githubUser: string;
  githubRepo: string;
  githubTokenSecretArn: string;
  isLocalStack: boolean;
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
      defaultBehavior: { origin: new origins.S3Origin(deployBucket) },
    });

    // --------------------------
    // CodeBuild Project for Docker Image Build
    // --------------------------
    const dockerBuildProject = new codebuild.PipelineProject(this, 'DockerBuildProject', {
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              // Check if package.json has changed in the current commit.
              // Note: This only checks the last commit. For a more robust check across history,
              // or against the last successfully built image, more complex logic is required
              // (e.g., storing package.json hash in S3 or ECR image metadata).
              'if git diff --quiet HEAD~1 -- package.json; then export SKIP_DOCKER_BUILD=true; else export SKIP_DOCKER_BUILD=false; fi',
              'echo "SKIP_DOCKER_BUILD is $SKIP_DOCKER_BUILD"',
              'echo Logging in to Amazon ECR...',
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin ' + nodeEcrRepo.repositoryUri,
            ],
          },
          build: {
            commands: [
              'if [ "$SKIP_DOCKER_BUILD" = "true" ]; then echo "Skipping Docker build as package.json has not changed."; else echo "Building Docker image..."; docker build -t vite-node-build:latest ./cdk/lib/build-image-dockerfile; docker tag vite-node-build:latest ' + nodeEcrRepo.repositoryUri + ':latest; fi',
            ],
          },
          post_build: {
            commands: [
              'if [ "$SKIP_DOCKER_BUILD" = "true" ]; then echo "Skipping Docker push as package.json has not changed."; else echo "Pushing Docker image..."; docker push ' + nodeEcrRepo.repositoryUri + ':latest; fi',
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
              'npm ci',
              'npm run build',
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
          branch: 'refs/tags/*', // Trigger only on tags
          oauthToken: props?.isLocalStack ? cdk.SecretValue.unsafePlainText(props?.githubTokenSecretArn!) : cdk.SecretValue.secretsManager(props?.githubTokenSecretArn!),
          output: sourceOutput,
          trigger: props?.isLocalStack ? codepipeline_actions.GitHubTrigger.POLL : codepipeline_actions.GitHubTrigger.WEBHOOK, // Use POLL for LocalStack, WEBHOOK for AWS
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
        new codepipeline_actions.CloudFormationCreateUpdateStackAction({
          actionName: 'Invalidate_CloudFront',
          templatePath: new codepipeline.Artifact('ViteBuildOutput').atPath('template.yml'), // dummy template, optional
          stackName: 'ViteCloudFrontInvalidation',
          adminPermissions: true,
        }),
      ],
    });
  }
}
