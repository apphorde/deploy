# deploy

Static site service

## Download the CLI

Download the script "deploy.sh" from https://github.com/apphorde/deploy and add to your environment.

In a terminal, fromn any folder on your machine (Mac or Linux):

```bash
curl -sS https://raw.githubusercontent.com/apphorde/deploy/refs/heads/main/deploy.sh -o deploy.sh
chmod +x deploy.sh
export PATH="$PWD:$PATH"
```

## Configuration

Define your deploy key in the environment

```bash
export DEPLOY_API_KEY=<your-key>
```

## Usage

Push local changes to a static page

```bash
deploy.sh push
```

Pull changes from the remote site into the current folder

```bash
deploy.sh pull <name>
```
