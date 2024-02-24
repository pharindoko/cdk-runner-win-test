"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/image-builders/aws-image-builder/delete-ami.lambda.ts
var delete_ami_lambda_exports = {};
__export(delete_ami_lambda_exports, {
  handler: () => handler
});
module.exports = __toCommonJS(delete_ami_lambda_exports);
var import_client_ec2 = require("@aws-sdk/client-ec2");

// src/lambda-helpers.ts
var import_client_secrets_manager = require("@aws-sdk/client-secrets-manager");
var sm = new import_client_secrets_manager.SecretsManagerClient();
async function customResourceRespond(event, responseStatus, reason, physicalResourceId, data) {
  const responseBody = JSON.stringify({
    Status: responseStatus,
    Reason: reason,
    PhysicalResourceId: physicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    NoEcho: false,
    Data: data
  });
  console.log("Responding", responseBody);
  const parsedUrl = require("url").parse(event.ResponseURL);
  const requestOptions = {
    hostname: parsedUrl.hostname,
    path: parsedUrl.path,
    method: "PUT",
    headers: {
      "content-type": "",
      "content-length": responseBody.length
    }
  };
  return new Promise((resolve, reject) => {
    try {
      const request = require("https").request(requestOptions, resolve);
      request.on("error", reject);
      request.write(responseBody);
      request.end();
    } catch (e) {
      reject(e);
    }
  });
}

// src/image-builders/aws-image-builder/delete-ami.lambda.ts
var ec2 = new import_client_ec2.EC2Client();
async function deleteAmis(stackName, builderName) {
  const images = await ec2.send(new import_client_ec2.DescribeImagesCommand({
    Owners: ["self"],
    Filters: [
      {
        Name: "tag:GitHubRunners:Stack",
        Values: [stackName]
      },
      {
        Name: "tag:GitHubRunners:Builder",
        Values: [builderName]
      }
    ]
  }));
  let imagesToDelete = images.Images ?? [];
  console.log(`Found ${imagesToDelete.length} AMIs`);
  console.log(JSON.stringify(imagesToDelete.map((i) => i.ImageId)));
  for (const image of imagesToDelete) {
    if (!image.ImageId) {
      console.warn(`No image id? ${JSON.stringify(image)}`);
      continue;
    }
    console.log(`Deregistering ${image.ImageId}`);
    await ec2.send(new import_client_ec2.DeregisterImageCommand({
      ImageId: image.ImageId
    }));
    for (const blockMapping of image.BlockDeviceMappings ?? []) {
      if (blockMapping.Ebs?.SnapshotId) {
        console.log(`Deleting ${blockMapping.Ebs.SnapshotId}`);
        await ec2.send(new import_client_ec2.DeleteSnapshotCommand({
          SnapshotId: blockMapping.Ebs.SnapshotId
        }));
      }
    }
  }
}
async function handler(event, context) {
  try {
    console.log(JSON.stringify({ ...event, ResponseURL: "..." }));
    switch (event.RequestType) {
      case "Create":
      case "Update":
        await customResourceRespond(event, "SUCCESS", "OK", "DeleteAmis", {});
        break;
      case "Delete":
        await deleteAmis(event.ResourceProperties.StackName, event.ResourceProperties.BuilderName);
        await customResourceRespond(event, "SUCCESS", "OK", event.PhysicalResourceId, {});
        break;
    }
  } catch (e) {
    console.error(e);
    await customResourceRespond(event, "FAILED", e.message || "Internal Error", context.logStreamName, {});
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handler
});
