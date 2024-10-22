#!/bin/bash

set -e

if [[ -z "$DEPLOY_API_KEY" ]];
  echo "Error: DEPLOY_API_KEY was not defined in the environment!"
  exit 2
fi

pull_project() {
  name="$1"

  if [[ -z "$name" ]]; then
    name=$(cat package.json | jq '.name' | sed s/\"//g)
  fi

  echo Pulling $name into $PWD
  curl -H 'Authorization: '$DEPLOY_API_KEY -X COPY https://static.apphor.de/$name -sS --output - | tar -xz -f - --keep-newer-files
}

push_project() {
  echo Pushing $PWD
  tar -cz -f - -C $PWD --exclude node_modules/ --exclude .git/ --exclude tmp/ . | curl -sS --output - -H 'Authorization: '$DEPLOY_API_KEY https://deploy.static.apphor.de/ --data-binary @-
}

deploy_help() {
  echo "Usage:"
  echo "  deploy.sh push <name>          Push current folder to a static site at <name>.static.apphor.de"
  echo "  deploy.sh pull <name>          Pull latest state from <name>.static.apphor.de to the current folder"
  echo ""
  echo "If not provided, the site name is expected in a local package.json file, with a name property"
}

if [[ "$1" == "push" ]]; then
  push_project $2
  exit $?
fi

if [[ "$1" == "pull" ]]; then
  pull_project $2
  exit $?
fi

if [[ "$1" == "help" ]]; then
  deploy_help
fi

