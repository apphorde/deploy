# deploy

This is a server for multiple static web pages or frontend libraries using subdomains.
It can host a full page, if the site has an `index.html`.
It can also host libraries if you want to use ES Module imports: `import x from 'https://...'`.

## API

The machine-readable API description is available at `/openapi.json` on the server.

Download an entire site:

```sh
site_name="hello-world"
curl -sS -H "Authorization: $DEPLOY_API_KEY" -X COPY "https://$site_name.static.apphor.de" --output - | tar -xz -f
```

Deploy a local folder:

```sh
site_name="hello-world"
tar -cz -f - -C $PWD --exclude node_modules/ --exclude .git/ . | curl -sS --output - -H "Authorization: $DEPLOY_API_KEY" https://$site_name.static.apphor.de/ --data-binary @-
```

## Download the shell extension

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

The server requires `BASE_DOMAIN` and `DATA_PATH`. It uses the request `Host` header for deployment routing by default; set `TRUST_PROXY=true` only when a trusted reverse proxy overwrites `X-Forwarded-Host`. Deployments are limited to 100 MiB by default and can be adjusted with `MAX_UPLOAD_BYTES`.

## Usage

Push local changes to a static page

```bash
deploy.sh push
```

Pull changes from the remote site into the current folder

```bash
deploy.sh pull <name>
```
