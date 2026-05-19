# proxy-server-vless

AWS CDK project that deploys a **VLESS** proxy server (no TLS) on **port 80** using an EC2 instance in `eu-west-1`.

> ⚠️ **Security notice:** Running VLESS without TLS exposes traffic to network inspection. Use only for testing or when wrapping traffic in an alternative encryption layer.

---

## Architecture

```
Internet
   │ TCP 80
   ▼
[AWS Security Group] ── allows 0.0.0.0/0 → TCP 80 (VLESS) and TCP 22 (SSH)
   │
   ▼
[EC2 t3.micro – Amazon Linux 2023]
   └── f2ray process  →  listens on :80, WebSocket path /vless-fallback
```

---

## Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18
- [AWS CDK v2](https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html) – `npm install -g aws-cdk`
- AWS credentials configured (`aws configure`)

---

## Deploy

```bash
# 1. Install dependencies
npm install

# 2. Bootstrap CDK in eu-west-1 (first time only)
npx cdk bootstrap aws://<ACCOUNT_ID>/eu-west-1

# 3. Synthesise the CloudFormation template
npx cdk synth

# 4. Deploy the stack
npx cdk deploy
```

After deployment, note the `InstancePublicIp` output – you will need it for the client config.

The `VlessLink` output contains the **ready-to-use VLESS URI** you can paste directly into any VLESS-compatible client (e.g. v2rayN, v2rayNG, Shadowrocket):

```
vless://<UUID>@<PUBLIC_IP>:80?encryption=none&security=none&type=ws&path=%2Fvless-fallback&host=<PUBLIC_IP>#vless-proxy
```

> The UUID is derived deterministically from the CDK stack id and a fixed namespace during `cdk synth`, then exposed again as the `VlessUuid` output and embedded in `VlessLink`.

---

## Server configuration

The server config template is at [`config/server-config.json`](config/server-config.json). During deployment, the EC2 user-data script automatically:

1. Installs f2ray via the official install script.
2. Injects the stable UUID that CDK already computed for this stack.
3. Writes `/usr/local/etc/f2ray/config.json`.
4. Enables and starts the `f2ray` systemd service.

---

## Client configuration

Copy [`config/client-config.json`](config/client-config.json) to your local client and replace the placeholder values:

| Placeholder | Replace with |
|---|---|
| `YOUR_AWS_EC2_PUBLIC_IP` | The `InstancePublicIp` CDK output |
| `YOUR_STABLE_UUID_FROM_CDK_OUTPUT` | The `VlessUuid` CDK output (also embedded in `VlessLink`) |

`YOUR_STABLE_UUID_FROM_CDK_OUTPUT` is only a placeholder in the sample JSON file:

- CDK does not rewrite `config/client-config.json` on disk.
- After `cdk deploy`, copy the `VlessUuid` output into that field.
- Or use **`VlessLink`** directly, since it already contains both the UUID and the public IP.

---

## Run tests

```bash
npm test
```

---

## Destroy

```bash
npx cdk destroy
```
