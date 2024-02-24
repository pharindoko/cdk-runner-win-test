import * as cdk from 'aws-cdk-lib';
import {
  Duration,
  RemovalPolicy,
  Stack,
  aws_ec2 as ec2,
  aws_iam as iam,
  aws_logs as logs,
  aws_stepfunctions as stepfunctions,
  aws_stepfunctions_tasks as stepfunctions_tasks,
} from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { IntegrationPattern } from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import { FastLaunchRunnerImageBuilder } from './fast-launch-ec2.builder';
import { Architecture, BaseProvider, Ec2RunnerProviderProps, IRunnerImageBuilder, IRunnerProvider, IRunnerProviderStatus, Os, RunnerAmi, RunnerImageBuilderProps, RunnerImageBuilderType, RunnerImageComponent, RunnerRuntimeParameters, RunnerVersion, amiRootDevice } from '@cloudsnorkel/cdk-github-runners';
export const MINIMAL_EC2_SSM_SESSION_MANAGER_POLICY_STATEMENT = new iam.PolicyStatement({
  actions: [
    'ssmmessages:CreateControlChannel',
    'ssmmessages:CreateDataChannel',
    'ssmmessages:OpenControlChannel',
    'ssmmessages:OpenDataChannel',
    's3:GetEncryptionConfiguration',
    'ssm:UpdateInstanceInformation',
  ],
  resources: ['*'],
});


// this script is specifically made so `poweroff` is absolutely always called
// each `{}` is a variable coming from `params` below and their order should match the linux script
const windowsUserDataTemplate = `<powershell>
$TASK_TOKEN = "{}"
$logGroupName="{}"
$runnerNamePath="{}"
$githubDomainPath="{}"
$ownerPath="{}"
$repoPath="{}"
$runnerTokenPath="{}"
$labels="{}"
$registrationURL="{}"

Start-Job -ScriptBlock {
  while (1) {
    aws stepfunctions send-task-heartbeat --task-token "$using:TASK_TOKEN"
    sleep 60
  }
}
function setup_logs () {
  echo '{
    "logs": {
      "log_stream_name": "unknown",
      "logs_collected": {
        "files": {
         "collect_list": [
            {
              "file_path": "/actions/runner.log",
              "log_group_name": "$logGroupName",
              "log_stream_name": "$runnerNamePath",
              "timezone": "UTC"
            }
          ]
        }
      }
    }
  }' | Out-File -Encoding ASCII $Env:TEMP/log.conf
  & "C:/Program Files/Amazon/AmazonCloudWatchAgent/amazon-cloudwatch-agent-ctl.ps1" -a fetch-config -m ec2 -s -c file:$Env:TEMP/log.conf
}
function action () {
  cd /actions
  $RunnerVersion = Get-Content RUNNER_VERSION -Raw
  if ($RunnerVersion -eq "latest") { $RunnerFlags = "" } else { $RunnerFlags = "--disableupdate" }
  ./config.cmd --unattended --url "\${registrationUrl}" --token "\${runnerTokenPath}" --ephemeral --work _work --labels "\${labels},cdkghr:started:$(Get-Date -UFormat +%s)" $RunnerFlags --name "\${runnerNamePath}" 2>&1 | Out-File -Encoding ASCII -Append /actions/runner.log

  if ($LASTEXITCODE -ne 0) { return 1 }
  ./run.cmd 2>&1 | Out-File -Encoding ASCII -Append /actions/runner.log
  if ($LASTEXITCODE -ne 0) { return 2 }

  $STATUS = Select-String -Path './_diag/*.log' -Pattern 'finish job request for job [0-9a-f\\-]+ with result: (.*)' | %{$_.Matches.Groups[1].Value} | Select-Object -Last 1

  if ($STATUS) {
      echo "CDKGHA JOB DONE \${labels} $STATUS" | Out-File -Encoding ASCII -Append /actions/runner.log
  }

  return 0

}
setup_logs
$r = action
if ($r -eq 0) {
  aws stepfunctions send-task-success --task-token "$TASK_TOKEN" --task-output '{ }'
} else {
  aws stepfunctions send-task-failure --task-token "$TASK_TOKEN"
}
Start-Sleep -Seconds 10  # give cloudwatch agent its default 5 seconds buffer duration to upload logs
Stop-Computer -ComputerName localhost -Force
</powershell>
`.replace(/{/g, '\\{').replace(/}/g, '\\}').replace(/\\{\\}/g, '{}');

/**
 * GitHub Actions runner provider using EC2 to execute jobs.
 *
 * This construct is not meant to be used by itself. It should be passed in the providers property for GitHubRunners.
 */
export class FastLaunchEc2RunnerProvider extends BaseProvider implements IRunnerProvider {
  /**
   * Create new image builder that builds EC2 specific runner images.
   *
   * You can customize the OS, architecture, VPC, subnet, security groups, etc. by passing in props.
   *
   * You can add components to the image builder by calling `imageBuilder.addComponent()`.
   *
   * The default OS is Ubuntu running on x64 architecture.
   *
   * Included components:
   *  * `RunnerImageComponent.requiredPackages()`
   *  * `RunnerImageComponent.runnerUser()`
   *  * `RunnerImageComponent.git()`
   *  * `RunnerImageComponent.githubCli()`
   *  * `RunnerImageComponent.awsCli()`
   *  * `RunnerImageComponent.docker()`
   *  * `RunnerImageComponent.githubRunner()`
   */
  public static imageBuilder(scope: Construct, id: string, props?: RunnerImageBuilderProps) {
    return new FastLaunchRunnerImageBuilder(scope, id, {
      os: Os.WINDOWS,
      architecture: Architecture.X86_64,
      builderType: RunnerImageBuilderType.AWS_IMAGE_BUILDER,
      components: [
        RunnerImageComponent.requiredPackages(),
        RunnerImageComponent.runnerUser(),
        RunnerImageComponent.git(),
        RunnerImageComponent.githubCli(),
        RunnerImageComponent.awsCli(),
        RunnerImageComponent.docker(),
        RunnerImageComponent.githubRunner(props?.runnerVersion ?? RunnerVersion.latest()),
      ],
      ...props,
    });
  }

  /**
   * Labels associated with this provider.
   */
  readonly labels: string[];

  /**
   * Grant principal used to add permissions to the runner role.
   */
  readonly grantPrincipal: iam.IPrincipal;

  /**
   * Log group where provided runners will save their logs.
   *
   * Note that this is not the job log, but the runner itself. It will not contain output from the GitHub Action but only metadata on its execution.
   */
  readonly logGroup: logs.ILogGroup;

  readonly retryableErrors = [
    'Ec2.Ec2Exception',
    'States.Timeout',
  ];

  private readonly amiBuilder: IRunnerImageBuilder;
  private readonly ami: RunnerAmi;
  private readonly role: iam.Role;
  private readonly instanceType: ec2.InstanceType;
  private readonly storageSize: cdk.Size;
  private readonly spot: boolean;
  private readonly spotMaxPrice: string | undefined;
  private readonly vpc: ec2.IVpc;
  private readonly subnets: ec2.ISubnet[];
  private readonly securityGroups: ec2.ISecurityGroup[];

  constructor(scope: Construct, id: string, props?: Ec2RunnerProviderProps) {
    super(scope, id, props);

    this.labels = props?.labels ?? ['ec2'];
    this.vpc = props?.vpc ?? ec2.Vpc.fromLookup(this, 'Default VPC', { isDefault: true });
    this.securityGroups = props?.securityGroup ? [props.securityGroup] : (props?.securityGroups ?? [new ec2.SecurityGroup(this, 'SG', { vpc: this.vpc })]);
    this.subnets = props?.subnet ? [props.subnet] : this.vpc.selectSubnets(props?.subnetSelection).subnets;
    this.instanceType = props?.instanceType ?? ec2.InstanceType.of(ec2.InstanceClass.M5, ec2.InstanceSize.LARGE);
    this.storageSize = props?.storageSize ?? cdk.Size.gibibytes(30); // 30 is the minimum for Windows
    this.spot = props?.spot ?? false;
    this.spotMaxPrice = props?.spotMaxPrice;

    this.amiBuilder = FastLaunchEc2RunnerProvider.imageBuilder(this, 'Ami Builder', {
      vpc: props?.vpc,
      subnetSelection: props?.subnetSelection,
      securityGroups: this.securityGroups,
    });
    this.ami = this.amiBuilder.bindAmi();

    if (!this.ami.architecture.instanceTypeMatch(this.instanceType)) {
      throw new Error(`AMI architecture (${this.ami.architecture.name}) doesn't match runner instance type (${this.instanceType} / ${this.instanceType.architecture})`);
    }

    this.grantPrincipal = this.role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
    this.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['states:SendTaskFailure', 'states:SendTaskSuccess', 'states:SendTaskHeartbeat'],
      resources: ['*'], // no support for stateMachine.stateMachineArn :(
      conditions: {
        StringEquals: {
          'aws:ResourceTag/aws:cloudformation:stack-id': cdk.Stack.of(this).stackId,
        },
      },
    }));
    this.grantPrincipal.addToPrincipalPolicy(MINIMAL_EC2_SSM_SESSION_MANAGER_POLICY_STATEMENT);

    this.logGroup = new logs.LogGroup(
      this,
      'Logs',
      {
        retention: props?.logRetention ?? RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      },
    );
    this.logGroup.grantWrite(this);
  }

  /**
   * Generate step function task(s) to start a new runner.
   *
   * Called by GithubRunners and shouldn't be called manually.
   *
   * @param parameters workflow job details
   */
  getStepFunctionTask(parameters: RunnerRuntimeParameters): stepfunctions.IChainable {
    // we need to build user data in two steps because passing the template as the first parameter to stepfunctions.JsonPath.format fails on syntax

    const params = [
      stepfunctions.JsonPath.taskToken,
      this.logGroup.logGroupName,
      parameters.runnerNamePath,
      parameters.githubDomainPath,
      parameters.ownerPath,
      parameters.repoPath,
      parameters.runnerTokenPath,
      this.labels.join(','),
      parameters.registrationUrl,
    ];

    const passUserData = new stepfunctions.Pass(this, `${this.labels.join(', ')} data`, {
      parameters: {
        userdataTemplate: windowsUserDataTemplate,
      },
      resultPath: stepfunctions.JsonPath.stringAt('$.ec2'),
    });

    // we use ec2:RunInstances because we must
    // we can't use fleets because they don't let us override user data, security groups or even disk size
    // we can't use requestSpotInstances because it doesn't support launch templates, and it's deprecated
    // ec2:RunInstances also seemed like the only one to immediately return an error when spot capacity is not available

    // we build a complicated chain of states here because ec2:RunInstances can only try one subnet at a time
    // if someone can figure out a good way to use Map for this, please open a PR

    // build a state for each subnet we want to try
    const instanceProfile = new iam.CfnInstanceProfile(this, 'Instance Profile', {
      roles: [this.role.roleName],
    });
    const rootDeviceResource = amiRootDevice(this, this.ami.launchTemplate.launchTemplateId);
    rootDeviceResource.node.addDependency(this.amiBuilder);
    const subnetRunners = this.subnets.map((subnet, index) => {
      return new stepfunctions_tasks.CallAwsService(this, `${this.labels.join(', ')} subnet${index + 1}`, {
        comment: subnet.subnetId,
        integrationPattern: IntegrationPattern.WAIT_FOR_TASK_TOKEN,
        service: 'ec2',
        action: 'runInstances',
        heartbeatTimeout: stepfunctions.Timeout.duration(Duration.minutes(10)),
        parameters: {
          LaunchTemplate: {
            LaunchTemplateId: this.ami.launchTemplate.launchTemplateId,
          },
          MinCount: 1,
          MaxCount: 1,
          UserData: stepfunctions.JsonPath.base64Encode(
            stepfunctions.JsonPath.format(
              stepfunctions.JsonPath.stringAt('$.ec2.userdataTemplate'),
              ...params,
            ),
          ),
          InstanceInitiatedShutdownBehavior: ec2.InstanceInitiatedShutdownBehavior.TERMINATE,
          IamInstanceProfile: {
            Arn: instanceProfile.attrArn,
          },
          MetadataOptions: {
            HttpTokens: 'required',
          },
          BlockDeviceMappings: [{
            DeviceName: rootDeviceResource.ref,
            Ebs: {
              DeleteOnTermination: true,
              VolumeSize: this.storageSize.toGibibytes(),
            },
          }],
          InstanceMarketOptions: this.spot ? {
            MarketType: 'spot',
            SpotOptions: {
              MaxPrice: this.spotMaxPrice,
              SpotInstanceType: 'one-time',
            },
          } : undefined,
        },
        iamResources: ['*'],
      });
    });

    // start with the first subnet
    passUserData.next(subnetRunners[0]);

    // chain up the rest of the subnets
    for (let i = 1; i < subnetRunners.length; i++) {
      subnetRunners[i - 1].addCatch(subnetRunners[i], {
        errors: ['Ec2.Ec2Exception', 'States.Timeout'],
        resultPath: stepfunctions.JsonPath.stringAt('$.lastSubnetError'),
      });
    }

    return passUserData;
  }

  grantStateMachine(stateMachineRole: iam.IGrantable) {
    stateMachineRole.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [this.role.roleArn],
      conditions: {
        StringEquals: {
          'iam:PassedToService': 'ec2.amazonaws.com',
        },
      },
    }));

    stateMachineRole.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ec2:createTags'],
      resources: [Stack.of(this).formatArn({
        service: 'ec2',
        resource: '*',
      })],
    }));

    stateMachineRole.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['iam:CreateServiceLinkedRole'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'iam:AWSServiceName': 'spot.amazonaws.com',
        },
      },
    }));
  }

  status(statusFunctionRole: iam.IGrantable): IRunnerProviderStatus {
    statusFunctionRole.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeLaunchTemplateVersions'],
      resources: ['*'],
    }));

    return {
      type: this.constructor.name,
      labels: this.labels,
      securityGroups: this.securityGroups.map(sg => sg.securityGroupId),
      roleArn: this.role.roleArn,
      logGroup: this.logGroup.logGroupName,
      ami: {
        launchTemplate: this.ami.launchTemplate.launchTemplateId || 'unknown',
        amiBuilderLogGroup: this.ami.logGroup?.logGroupName,
      },
    };
  }

  /**
   * The network connections associated with this resource.
   */
  public get connections(): ec2.Connections {
    return new ec2.Connections({ securityGroups: this.securityGroups });
  }
}
