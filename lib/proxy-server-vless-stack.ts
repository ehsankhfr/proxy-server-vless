import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class ProxyServerVlessStack extends cdk.Stack {
  /** The security group attached to the VLESS proxy instance */
  public readonly securityGroup: ec2.SecurityGroup;
  /** The EC2 instance running the VLESS proxy */
  public readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------------------
    // VPC – single public subnet, one AZ to minimise cost
    // ---------------------------------------------------------------------------
    const vpc = new ec2.Vpc(this, 'VlessVpc', {
      maxAzs: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    // ---------------------------------------------------------------------------
    // Security Group
    // Allow inbound TCP port 80 from anywhere (VLESS plain traffic)
    // ---------------------------------------------------------------------------
    this.securityGroup = new ec2.SecurityGroup(this, 'VlessSecurityGroup', {
      vpc,
      securityGroupName: 'vless-proxy-sg',
      description: 'Security group for VLESS proxy server - allows inbound HTTP (port 80)',
      allowAllOutbound: true,
    });

    // Inbound rule: Allow all IPv4 traffic on port 80 (plain VLESS over WebSocket)
    this.securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow inbound VLESS plain traffic on port 80',
    );

    // Also allow SSH so you can manage the instance
    this.securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      'Allow inbound SSH',
    );

    // ---------------------------------------------------------------------------
    // User-data script – installs f2ray and writes the server config
    // ---------------------------------------------------------------------------
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      // Install f2ray using the official script
      'bash <(curl -L https://raw.githubusercontent.com/v2fly/f2ray-core/master/release/install-release.sh)',
      // Generate a UUID and write the server config
      'UUID=$(uuidgen)',
      'mkdir -p /usr/local/etc/f2ray /var/log/f2ray',
      'cat > /usr/local/etc/f2ray/config.json <<EOCFG',
      '{',
      '  "log": {',
      '    "access": "/var/log/f2ray/access.log",',
      '    "error": "/var/log/f2ray/error.log",',
      '    "loglevel": "warning"',
      '  },',
      '  "inbounds": [',
      '    {',
      '      "port": 80,',
      '      "protocol": "vless",',
      '      "settings": {',
      '        "clients": [',
      '          {',
      `            "id": "$UUID",`,
      '            "level": 0',
      '          }',
      '        ],',
      '        "decryption": "none"',
      '      },',
      '      "streamSettings": {',
      '        "network": "ws",',
      '        "wsSettings": {',
      '          "path": "/vless-fallback"',
      '        }',
      '      }',
      '    }',
      '  ],',
      '  "outbounds": [',
      '    {',
      '      "protocol": "freedom",',
      '      "settings": {}',
      '    }',
      '  ]',
      '}',
      'EOCFG',
      // Print the UUID so it is visible in the EC2 instance system log
      'echo "VLESS UUID: $UUID"',
      // Enable and start the f2ray service
      'systemctl enable f2ray',
      'systemctl restart f2ray',
    );

    // ---------------------------------------------------------------------------
    // EC2 Instance – Amazon Linux 2023, t3.micro
    // ---------------------------------------------------------------------------
    this.instance = new ec2.Instance(this, 'VlessProxyInstance', {
      vpc,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO,
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: this.securityGroup,
      userData,
      associatePublicIpAddress: true,
      instanceName: 'vless-proxy-server',
    });

    // ---------------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'InstancePublicIp', {
      value: this.instance.instancePublicIp,
      description: 'Public IP of the VLESS proxy server – use this as YOUR_AWS_EC2_PUBLIC_IP in client config',
    });

    new cdk.CfnOutput(this, 'SecurityGroupId', {
      value: this.securityGroup.securityGroupId,
      description: 'ID of the VLESS proxy security group',
    });

    new cdk.CfnOutput(this, 'VlessServerPort', {
      value: '80',
      description: 'Port on which the VLESS server listens',
    });
  }
}
