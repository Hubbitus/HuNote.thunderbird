#!/usr/bin/bash

gh run watch $(gh run list --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId')