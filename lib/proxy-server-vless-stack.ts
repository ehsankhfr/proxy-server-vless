import * as crypto from 'crypto';
import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class ProxyServerVlessStack extends cdk.Stack {
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // OPTION A: Generate a unique UUID linked to this stack instance name so it doesn't change on every deploy.
    // OPTION B: Replace this with a hardcoded string if you want absolute control: const uuid = "your-fixed-uuid-here";
    const namespace = '6a131b74-0f2d-4bfb-b6d8-dc2f4044ee78'; // Arbitrary stable namespace
    const uuid = crypto
      .createHash('sha1')
      .update(id + namespace)
      .digest('hex')
      .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

    // ---------------------------------------------------------------------------
    // VPC – Single public subnet, one AZ to minimize cost
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
    // ---------------------------------------------------------------------------
    this.securityGroup = new ec2.SecurityGroup(this, 'VlessSecurityGroup', {
      vpc,
      securityGroupName: 'vless-proxy-sg',
      description: 'Security group for VLESS proxy server - allows inbound HTTP (port 80)',
      allowAllOutbound: true,
    });

    this.securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow inbound VLESS plain traffic on port 80',
    );

    this.securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      'Allow inbound SSH',
    );

    // ---------------------------------------------------------------------------
    // User-data script
    // ---------------------------------------------------------------------------
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      'retry() {',
      '  local attempts=0',
      '  local max_attempts=5',
      '  local wait_seconds=6',
      '  while true; do',
      '    "$@" && break',
      '    attempts=$((attempts + 1))',
      '    if [ "$attempts" -ge "$max_attempts" ]; then',
      '      echo "Command failed after $max_attempts attempts: $*"',
      '      return 1',
      '    fi',
      '    sleep "$wait_seconds"',
      '  done',
      '}',
      'retry dnf update -y',
      'retry dnf install -y nginx curl tar jq',
      'retry curl -fLsS https://raw.githubusercontent.com/v2fly/fhs-install-v2ray/master/install-release.sh -o /tmp/install-v2ray.sh',
      'retry bash /tmp/install-v2ray.sh',
      `UUID="${uuid}"`,
      'mkdir -p /usr/local/etc/v2ray /var/log/v2ray',
      'cat > /usr/local/etc/v2ray/config.json <<EOCFG',
      '{',
      '  "log": {',
      '    "access": "/var/log/v2ray/access.log",',
      '    "error": "/var/log/v2ray/error.log",',
      '    "loglevel": "warning"',
      '  },',
      '  "inbounds": [',
      '    {',
      '      "port": 10000,',
      '      "listen": "127.0.0.1",',
      '      "protocol": "vless",',
      '      "settings": {',
      '        "clients": [',
      '          {',
      `            "id": "${uuid}",`,
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
      'systemctl enable v2ray',
      'systemctl restart v2ray || { journalctl -u v2ray -n 50; exit 1; }',
      "cat > /etc/nginx/nginx.conf << 'EONGINXMAIN'",
      'user nginx;',
      'worker_processes auto;',
      'error_log /var/log/nginx/error.log;',
      'pid /run/nginx.pid;',
      'include /usr/share/nginx/modules/*.conf;',
      'events {',
      '    worker_connections 1024;',
      '}',
      'http {',
      '    log_format main \'$remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent\';',
      '    access_log /var/log/nginx/access.log main;',
      '    sendfile on;',
      '    keepalive_timeout 65;',
      '    include /etc/nginx/mime.types;',
      '    default_type application/octet-stream;',
      '    include /etc/nginx/conf.d/*.conf;',
      '}',
      'EONGINXMAIN',
      "cat > /etc/nginx/conf.d/vless-proxy.conf << 'EONGINX'",
      'server {',
      '    listen 80 default_server;',
      '    server_name _;',
      '    location /vless-fallback {',
      '        proxy_pass http://127.0.0.1:10000;',
      '        proxy_http_version 1.1;',
      '        proxy_set_header Upgrade $http_upgrade;',
      '        proxy_set_header Connection "upgrade";',
      '        proxy_set_header Host $host;',
      '        proxy_set_header X-Real-IP $remote_addr;',
      '        proxy_connect_timeout 60s;',
      '        proxy_read_timeout 86400s;',
      '        proxy_send_timeout 86400s;',
      '    }',
      '    location / {',
      '        return 200 "OK";',
      '        add_header Content-Type text/plain;',
      '    }',
      '}',
      'EONGINX',
      'systemctl enable nginx',
      'systemctl restart nginx || { journalctl -u nginx -n 50; exit 1; }',
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

    new cdk.CfnOutput(this, 'VlessUuid', {
      value: uuid,
      description: 'UUID used to authenticate VLESS clients',
    });

    new cdk.CfnOutput(this, 'VlessLink', {
      value: `vless://${uuid}@${this.instance.instancePublicIp}:80?encryption=none&security=none&type=ws&path=%2Fvless-fallback&host=${this.instance.instancePublicIp}#vless-proxy`,
      description: 'Ready-to-use VLESS client link – paste into your VLESS client',
    });
  }
}
