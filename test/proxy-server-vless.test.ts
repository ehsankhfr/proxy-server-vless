import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ProxyServerVlessStack } from '../lib/proxy-server-vless-stack';

describe('ProxyServerVlessStack', () => {
  // Use a dummy account/region so CDK resolves correctly
  const env = { account: '123456789012', region: 'eu-west-1' };

  let app: cdk.App;
  let stack: ProxyServerVlessStack;
  let template: Template;

  beforeEach(() => {
    app = new cdk.App();
    stack = new ProxyServerVlessStack(app, 'TestStack', { env });
    template = Template.fromStack(stack);
  });

  test('Security group is created with inbound rule on port 80', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for VLESS proxy server - allows inbound HTTP (port 80)',
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({
          IpProtocol: 'tcp',
          FromPort: 80,
          ToPort: 80,
          CidrIp: '0.0.0.0/0',
          Description: 'Allow inbound VLESS plain traffic on port 80',
        }),
      ]),
    });
  });

  test('Security group allows SSH on port 22', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({
          IpProtocol: 'tcp',
          FromPort: 22,
          ToPort: 22,
          CidrIp: '0.0.0.0/0',
          Description: 'Allow inbound SSH',
        }),
      ]),
    });
  });

  test('EC2 instance is created with t3.micro', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 't3.micro',
    });
  });

  test('Stack outputs include InstancePublicIp and SecurityGroupId', () => {
    template.hasOutput('InstancePublicIp', {});
    template.hasOutput('SecurityGroupId', {});
    template.hasOutput('VlessServerPort', { Value: '80' });
    template.hasOutput('VlessUuid', {});
    template.hasOutput('VlessLink', {});
  });
});
