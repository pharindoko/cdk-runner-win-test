#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import "source-map-support/register";
import { GithubActionsRunnerStack } from "../lib/github-actions-runner.stack";

const app = new App();

new GithubActionsRunnerStack(app, `gh-runner`, {
    env: {
        account: process.env.CDK_DEPLOY_ACCOUNT ?? process.env.CDK_DEFAULT_ACCOUNT,
        region: "eu-central-1",
    },
    internalSubnetIds: ['subnet-xxxxxxxxxxxxx'],
    vpcId: 'vpc-xxxxxxx',
}
);
