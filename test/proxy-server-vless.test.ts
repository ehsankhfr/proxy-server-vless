import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
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

  test('User data renders valid v2ray and nginx config commands', () => {
    const renderedUserData = stack.instance.userData.render();

    expect(renderedUserData).toContain('cat > /usr/local/etc/v2ray/config.json <<EOCFG');
    expect(renderedUserData).toContain('"protocol": "vless"');
    expect(renderedUserData).toContain('"id": "$UUID"');
    expect(renderedUserData).toContain('cat > /etc/nginx/nginx.conf << \'EONGINXMAIN\'');
    expect(renderedUserData).toContain('cat > /etc/nginx/conf.d/vless-proxy.conf << \'EONGINX\'');
    expect(renderedUserData).toContain('proxy_pass http://127.0.0.1:10000;');
  });

  test('User data heredocs preserve nginx variables and expand the runtime UUID', () => {
    const renderedUserData = stack.instance.userData.render();
    const tempDir = mkdtempSync(join(tmpdir(), 'proxy-server-vless-'));
    const v2rayDir = join(tempDir, 'v2ray');
    const nginxDir = join(tempDir, 'nginx');
    const runtimeUuid = 'runtime-test-uuid';

    try {
      mkdirSync(v2rayDir);
      mkdirSync(nginxDir);

      const extractBlock = (startMarker: string, endMarker: string): string => {
        const startIndex = renderedUserData.indexOf(startMarker);
        const endIndex = renderedUserData.indexOf(`\n${endMarker}`, startIndex);

        expect(startIndex).toBeGreaterThanOrEqual(0);
        expect(endIndex).toBeGreaterThanOrEqual(0);

        return renderedUserData.slice(startIndex, endIndex + endMarker.length + 1);
      };

      const v2rayBlock = extractBlock(
        'cat > /usr/local/etc/v2ray/config.json <<EOCFG',
        'EOCFG',
      ).replace('/usr/local/etc/v2ray/config.json', `${v2rayDir}/config.json`);

      const nginxBlock = extractBlock(
        'cat > /etc/nginx/conf.d/vless-proxy.conf << \'EONGINX\'',
        'EONGINX',
      ).replace('/etc/nginx/conf.d/vless-proxy.conf', `${nginxDir}/vless-proxy.conf`);

      execFileSync(
        'bash',
        [
          '-c',
          [`UUID="${runtimeUuid}"`, v2rayBlock, nginxBlock].join('\n'),
        ],
        { cwd: tempDir },
      );

      expect(readFileSync(join(v2rayDir, 'config.json'), 'utf8')).toContain(
        `"id": "${runtimeUuid}"`,
      );
      expect(readFileSync(join(nginxDir, 'vless-proxy.conf'), 'utf8')).toContain(
        'proxy_set_header Host $host;',
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
