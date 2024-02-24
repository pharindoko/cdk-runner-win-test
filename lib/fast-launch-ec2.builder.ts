import { RunnerImageBuilder, RunnerAmi, Os, ImageBuilderComponent, RunnerImageBuilderProps, defaultBaseAmi, IConfigurableRunnerImageBuilder, RunnerImage, uniqueImageBuilderName, AmiRecipe, RunnerVersion, Architecture } from '@cloudsnorkel/cdk-github-runners';
import * as cdk from 'aws-cdk-lib';
import {
  Annotations,
  CustomResource,
  Duration,
  RemovalPolicy,
  Stack,
  aws_ec2 as ec2,
  aws_events as events,
  aws_events_targets as events_targets,
  aws_iam as iam,
  aws_imagebuilder as imagebuilder,
  aws_logs as logs,
} from 'aws-cdk-lib';
import { CfnLaunchTemplate } from 'aws-cdk-lib/aws-ec2';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { aws_lambda as lambda } from 'aws-cdk-lib';
import * as path from 'path';
import { DeleteAmiFunction } from './delete-ami-function';
import { IdleRunnerRepearFunction } from './idle-runner-repear-function';

export function singletonLambda<FunctionType extends lambda.Function>(
  functionType: new (s: Construct, i: string, p?: lambda.FunctionOptions) => FunctionType,
  scope: Construct, id: string, props?: lambda.FunctionOptions): FunctionType {

  const constructName = `${id}-dcc036c8-876b-451e-a2c1-552f9e06e9e1`;
  const existing = cdk.Stack.of(scope).node.tryFindChild(constructName);
  if (existing) {
    // Just assume this is true
    return existing as FunctionType;
  }

  return new functionType(cdk.Stack.of(scope), constructName, props);
}

/**
 * @internal
 */
export class FastLaunchRunnerImageBuilder extends RunnerImageBuilder {
  private boundAmi?: RunnerAmi;
  private readonly os: Os;
  private readonly architecture: Architecture;
  private readonly baseAmi: string;
  private readonly logRetention: RetentionDays;
  private readonly logRemovalPolicy: RemovalPolicy;
  private readonly vpc: ec2.IVpc;
  private readonly securityGroups: ec2.ISecurityGroup[];
  private readonly subnetSelection: ec2.SubnetSelection | undefined;
  private readonly rebuildInterval: cdk.Duration;
  private readonly boundComponents: ImageBuilderComponent[] = [];
  private readonly instanceType: ec2.InstanceType;
  private infrastructure: imagebuilder.CfnInfrastructureConfiguration | undefined;
  private readonly role: iam.Role;


  constructor(scope: Construct, id: string, props?: RunnerImageBuilderProps) {
    super(scope, id, props);

    if (props?.codeBuildOptions) {
      Annotations.of(this).addWarning('codeBuildOptions are ignored when using AWS Image Builder to build runner images.');
    }

    this.os = Os.WINDOWS;
    this.architecture = props?.architecture ?? Architecture.X86_64;
    this.rebuildInterval = props?.rebuildInterval ?? Duration.days(7);
    this.logRetention = props?.logRetention ?? RetentionDays.ONE_MONTH;
    this.logRemovalPolicy = props?.logRemovalPolicy ?? RemovalPolicy.DESTROY;
    this.vpc = props?.vpc ?? ec2.Vpc.fromLookup(this, 'VPC', { isDefault: true });
    this.securityGroups = props?.securityGroups ?? [new ec2.SecurityGroup(this, 'SG', { vpc: this.vpc })];
    this.subnetSelection = props?.subnetSelection;
    this.baseAmi = props?.baseAmi ?? defaultBaseAmi(this, this.os, this.architecture);
    this.instanceType = props?.awsImageBuilderOptions?.instanceType ?? ec2.InstanceType.of(ec2.InstanceClass.M5, ec2.InstanceSize.LARGE);

    // confirm instance type
    if (!this.architecture.instanceTypeMatch(this.instanceType)) {
      throw new Error(`Builder architecture (${this.architecture.name}) doesn't match selected instance type (${this.instanceType} / ${this.instanceType.architecture})`);
    }

    // warn against isolated networks
    if (props?.subnetSelection?.subnetType == ec2.SubnetType.PRIVATE_ISOLATED) {
      Annotations.of(this).addWarning('Private isolated subnets cannot pull from public ECR and VPC endpoint is not supported yet. ' +
        'See https://github.com/aws/containers-roadmap/issues/1160');
    }

    // role to be used by AWS Image Builder
    this.role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
  }
  // eslint-disable-next-line @typescript-eslint/member-ordering
  static new(scope: Construct, id: string, props?: RunnerImageBuilderProps): IConfigurableRunnerImageBuilder {
    return new FastLaunchRunnerImageBuilder(scope, id, props);

  }

  /**
   * Called by IRunnerProvider to finalize settings and create the image builder.
   */
  bindDockerImage(): RunnerImage {
    throw new Error('Docker is not in scope. Fast Launch option works only for AMI');

  }

  protected createLog(id: string, recipeName: string): logs.LogGroup {
    return new logs.LogGroup(this, id, {
      logGroupName: `/aws/imagebuilder/${recipeName}`,
      retention: this.logRetention,
      removalPolicy: this.logRemovalPolicy,
    });
  }

  protected createInfrastructure(managedPolicies: iam.IManagedPolicy[]): imagebuilder.CfnInfrastructureConfiguration {
    if (this.infrastructure) {
      return this.infrastructure;
    }

    for (const managedPolicy of managedPolicies) {
      this.role.addManagedPolicy(managedPolicy);
    }

    for (const component of this.boundComponents) {
      component.grantAssetsRead(this.role);
    }

    this.infrastructure = new imagebuilder.CfnInfrastructureConfiguration(this, 'Infrastructure', {
      name: uniqueImageBuilderName(this),
      // description: this.description,
      subnetId: this.vpc?.selectSubnets(this.subnetSelection).subnetIds[0],
      securityGroupIds: this.securityGroups?.map(sg => sg.securityGroupId),
      instanceTypes: [this.instanceType.toString()],
      instanceMetadataOptions: {
        httpTokens: 'required',
        // Container builds require a minimum of two hops.
        httpPutResponseHopLimit: 2,
      },
      instanceProfileName: new iam.CfnInstanceProfile(this, 'Instance Profile', {
        roles: [
          this.role.roleName,
        ],
      }).ref,
    });

    return this.infrastructure;
  }

  protected createImage(infra: imagebuilder.CfnInfrastructureConfiguration, log: logs.LogGroup,
    imageRecipeArn?: string, containerRecipeArn?: string): imagebuilder.CfnImage {
    const image = new imagebuilder.CfnImage(this, this.amiOrContainerId('Image', imageRecipeArn, containerRecipeArn), {
      infrastructureConfigurationArn: infra.attrArn,
      imageRecipeArn,
      containerRecipeArn,
      imageTestsConfiguration: {
        imageTestsEnabled: false,
      },
    });
    image.node.addDependency(infra);
    image.node.addDependency(log);

    return image;
  }

  // eslint-disable-next-line max-len
  protected createImageWithDistribution(infra: imagebuilder.CfnInfrastructureConfiguration, dist: imagebuilder.CfnDistributionConfiguration, log: logs.LogGroup,
    imageRecipeArn?: string, containerRecipeArn?: string): imagebuilder.CfnImage {
    const image = new imagebuilder.CfnImage(this, this.amiOrContainerId('ImageWithDist', imageRecipeArn, containerRecipeArn), {
      infrastructureConfigurationArn: infra.attrArn,
      distributionConfigurationArn: dist.attrArn,
      imageRecipeArn,
      containerRecipeArn,
      imageTestsConfiguration: {
        imageTestsEnabled: false,
      },
    });
    image.node.addDependency(infra);
    image.node.addDependency(log);

    return image;
  }

  private amiOrContainerId(baseId: string, imageRecipeArn?: string, containerRecipeArn?: string) {
    if (imageRecipeArn) {
      return `AMI ${baseId}`;
    }
    if (containerRecipeArn) {
      return `Docker ${baseId}`;
    }
    throw new Error('Either imageRecipeArn or containerRecipeArn must be defined');
  }

  protected createPipeline(infra: imagebuilder.CfnInfrastructureConfiguration, dist: imagebuilder.CfnDistributionConfiguration, log: logs.LogGroup,
    imageRecipeArn?: string, containerRecipeArn?: string): imagebuilder.CfnImagePipeline {
    let scheduleOptions: imagebuilder.CfnImagePipeline.ScheduleProperty | undefined;
    if (this.rebuildInterval.toDays() > 0) {
      scheduleOptions = {
        scheduleExpression: events.Schedule.rate(this.rebuildInterval).expressionString,
        pipelineExecutionStartCondition: 'EXPRESSION_MATCH_ONLY',
      };
    }
    const pipeline = new imagebuilder.CfnImagePipeline(this, this.amiOrContainerId('Pipeline', imageRecipeArn, containerRecipeArn), {
      name: uniqueImageBuilderName(this),
      // description: this.description,
      infrastructureConfigurationArn: infra.attrArn,
      distributionConfigurationArn: dist.attrArn,
      imageRecipeArn,
      containerRecipeArn,
      schedule: scheduleOptions,
      imageTestsConfiguration: {
        imageTestsEnabled: false,

      }
    });
    pipeline.node.addDependency(infra);
    pipeline.node.addDependency(log);

    return pipeline;
  }

  /**
   * The network connections associated with this resource.
   */
  public get connections(): ec2.Connections {
    return new ec2.Connections({ securityGroups: this.securityGroups });
  }

  public get grantPrincipal(): iam.IPrincipal {
    return this.role;
  }

  bindAmi(): RunnerAmi {
    if (this.boundAmi) {
      return this.boundAmi;
    }


    const recipe = new AmiRecipe(this, 'Ami Recipe', {
      platform: 'Windows',
      components: this.bindComponents(),
      architecture: this.architecture,
      baseAmi: this.baseAmi,
    });

    const log = this.createLog('Ami Log', recipe.name);
    const infra = this.createInfrastructure([
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      iam.ManagedPolicy.fromAwsManagedPolicyName('EC2InstanceProfileForImageBuilder'),
    ]);
    const image = this.createImage(infra, log, recipe.arn, undefined);


    const stackName = cdk.Stack.of(this).stackName;
    const builderName = this.node.path;

    const cfnLaunchTemplate = new CfnLaunchTemplate(this, 'Launch template', {
      launchTemplateName: uniqueImageBuilderName(this),
      launchTemplateData: {
        imageId: image.attrImageId,
        instanceType: 't3a.large',
        networkInterfaces: [{
          subnetId: this.vpc.selectSubnets(this.subnetSelection).subnetIds[0],
          deviceIndex: 0,
          groups: this.securityGroups.map(sg => sg.securityGroupId),
        }],
      },
    });

    const launchTemplate = ec2.LaunchTemplate.fromLaunchTemplateAttributes(this, 'Launch Template', {
      launchTemplateId: cfnLaunchTemplate.attrLaunchTemplateId,
    });


    const dist = new imagebuilder.CfnDistributionConfiguration(this, 'AMI Distribution', {
      name: uniqueImageBuilderName(this),
      // description: this.description,
      distributions: [
        {
          region: Stack.of(this).region,
          amiDistributionConfiguration: {
            Name: `${cdk.Names.uniqueResourceName(this, {
              maxLength: 90,
              separator: '-',
              allowedSpecialCharacters: '_-',
            })}-{{ imagebuilder:buildDate }}`,
            AmiTags: {
              'Name': this.node.id,
              'GitHubRunners:Stack': stackName,
              'GitHubRunners:Builder': builderName,
            },
          },
          launchTemplateConfigurations: [
            {
              launchTemplateId: launchTemplate.launchTemplateId,
            },
          ],
          fastLaunchConfigurations: [{
            accountId: Stack.of(this).account,
            enabled: true,
            launchTemplate: {
              launchTemplateId: launchTemplate.launchTemplateId,
            },
            maxParallelLaunches: 6,
            snapshotConfiguration: {
              targetResourceCount: 5,
            },
          }],
        },
      ],
    });

    // this.createImageWithDistribution(infra, dist, log, recipe.arn, undefined);
    this.createPipeline(infra, dist, log, recipe.arn, undefined);
    this.boundAmi = {
      launchTemplate: launchTemplate,
      architecture: this.architecture,
      os: this.os,
      logGroup: log,
      runnerVersion: RunnerVersion.specific('unknown'),
    };

    this.amiCleaner(launchTemplate, stackName, builderName);
    this.reaper(recipe.name, 'AMI');

    return this.boundAmi;
  }

  private amiCleaner(launchTemplate: ec2.ILaunchTemplate, stackName: string, builderName: string) {
    const deleter = singletonLambda(DeleteAmiFunction, this, 'delete-ami', {
      description: 'Delete old GitHub Runner AMIs',
      initialPolicy: [
        new iam.PolicyStatement({
          actions: ['ec2:DescribeLaunchTemplateVersions', 'ec2:DescribeImages', 'ec2:DeregisterImage', 'ec2:DeleteSnapshot'],
          resources: ['*'],
        }),
      ],
      timeout: cdk.Duration.minutes(5),
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // delete old AMIs on schedule
    const eventRule = new events.Rule(this, 'Delete AMI Schedule', {
      schedule: events.Schedule.rate(cdk.Duration.days(1)),
      description: `Delete old AMIs for ${builderName}`,
    });
    eventRule.addTarget(new events_targets.LambdaFunction(deleter, {
      event: events.RuleTargetInput.fromObject({
        RequestType: 'Scheduled',
        LaunchTemplateId: launchTemplate.launchTemplateId,
        StackName: stackName,
        BuilderName: builderName,
      }),
    }));

    // delete all AMIs when this construct is removed
    new CustomResource(this, 'AMI Deleter', {
      serviceToken: deleter.functionArn,
      resourceType: 'Custom::AmiDeleter',
      properties: {
        StackName: stackName,
        BuilderName: builderName,
      },
    });
  }

  private bindComponents(): ImageBuilderComponent[] {
    if (this.boundComponents.length == 0) {
      this.boundComponents.push(...this.components.map((c, i) => c._asAwsImageBuilderComponent(this, `Component ${i} ${c.name}`, this.os, this.architecture)));
    }

    return this.boundComponents;
  }

  private reaper(recipeName: string, imageType: 'Docker' | 'AMI') {
    const reaper = singletonLambda(IdleRunnerRepearFunction, this, 'Reaper', {
      description: 'AWS Image Builder version reaper deletes old image build versions pointing to deleted AMIs/Docker images',
      timeout: cdk.Duration.minutes(3),
      logRetention: logs.RetentionDays.ONE_MONTH,
      initialPolicy: [
        new iam.PolicyStatement({
          actions: [
            'imagebuilder:ListImages',
            'imagebuilder:ListImageBuildVersions',
            'imagebuilder:DeleteImage',
            'ec2:DescribeImages',
            'ecr:DescribeImages',
          ],
          resources: ['*'],
        }),
      ],
    });

    const scheduleRule = new events.Rule(this, `Reaper Schedule ${imageType}`, {
      description: `Delete old image build versions for ${recipeName}`,
      schedule: events.Schedule.rate(cdk.Duration.days(1)),
    });

    scheduleRule.addTarget(new events_targets.LambdaFunction(reaper, {
      event: events.RuleTargetInput.fromObject({
        RecipeName: recipeName,
      }),
    }));
  }
}
