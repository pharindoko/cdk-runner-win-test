import {
  Architecture,
  GitHubRunners,
  LambdaAccess,
  Os
} from "@cloudsnorkel/cdk-github-runners";
import {
  Duration,
  Stack,
  StackProps,
  aws_apigateway as apigateway,
  aws_ec2 as ec2,
  aws_stepfunctions as stepfunctions
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { FastLaunchEc2RunnerProvider } from "./fast-launch-ec2.provider";

export interface GithubServiceStackProps extends StackProps {
  internalSubnetIds: string[];
  vpcId: string;
}

export class GithubActionsRunnerStack extends Stack {
  public readonly apiGateway: apigateway.LambdaRestApi;
  public readonly domains: apigateway.IDomainName[];
  public readonly vpcEndpointId: ec2.IInterfaceVpcEndpoint;
  constructor(scope: Construct, id: string, props: GithubServiceStackProps) {
    super(scope, id, props);

    const existingVpc = ec2.Vpc.fromLookup(this, `VPC`, {

      region: props?.env?.region,
      vpcId: props.vpcId,
    });

    let vpcPrivateSubnets = {
      subnets: props.internalSubnetIds.map((ip, index) =>
        ec2.Subnet.fromSubnetId(this, `Subnet${index}`, ip),
      ),
    };


    let vpcPrivateSubnetFastLaunch = {
      subnets: [
        ec2.Subnet.fromSubnetId(this, 'SubnetFastLaunch', props.internalSubnetIds[0]),
      ],
    };

    const WindowsBuilder = FastLaunchEc2RunnerProvider.imageBuilder(
      this,
      'x64-windows-builder',
      {
        vpc: existingVpc,
        subnetSelection: vpcPrivateSubnetFastLaunch,
        os: Os.WINDOWS,
        architecture: Architecture.X86_64,
        logRetention: 7,
        baseAmi: ec2.MachineImage.latestWindows(ec2.WindowsVersion.WINDOWS_SERVER_2022_ENGLISH_CORE_BASE).getImage(this).imageId,
        awsImageBuilderOptions: {
          instanceType: ec2.InstanceType.of(
            ec2.InstanceClass.M5,
            ec2.InstanceSize.XLARGE4,
          ),
        },
        rebuildInterval: Duration.days(7),
        securityGroups: [
          new ec2.SecurityGroup(this, 'windows-sg', {
            allowAllOutbound: true,
            vpc: existingVpc,
          }),
        ],
      },
    );

    const cloudPlatformsFastLaunchWindowsRunner = new FastLaunchEc2RunnerProvider(
      this,
      `${this.stackName}-win-runner`,
      {
        labels: ['cloudplatforms-windows-fast'],
        vpc: existingVpc,
        subnetSelection: vpcPrivateSubnetFastLaunch,
        spot: false,
        instanceType: ec2.InstanceType.of(
          ec2.InstanceClass.T3A,
          ec2.InstanceSize.LARGE,
        ),
        amiBuilder: WindowsBuilder,
      },
    );

    const providers = [
      cloudPlatformsFastLaunchWindowsRunner
    ];

    new GitHubRunners(this, `${this.stackName}-github-runner`, {
      providers,
      vpc: existingVpc,
      vpcSubnets: vpcPrivateSubnets,
      logOptions: {
        includeExecutionData: true,
        level: stepfunctions.LogLevel.ALL,
        logGroupName: `${this.stackName}-state-machine`,

      },
      requireSelfHostedLabel: false,
      statusAccess: LambdaAccess.noAccess(),
      allowPublicSubnet: true,
    });

  }
}
