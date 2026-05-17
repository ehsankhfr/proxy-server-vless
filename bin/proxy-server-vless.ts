#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { ProxyServerVlessStack } from '../lib/proxy-server-vless-stack';

const app = new cdk.App();
new ProxyServerVlessStack(app, 'ProxyServerVlessStack', {
  env: { region: 'eu-west-1' },
  description: 'VLESS proxy server on port 80 (no TLS) deployed on EC2 in eu-west-1',
});
