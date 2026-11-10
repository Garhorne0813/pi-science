#!/usr/bin/env bash
for item in {1..10}; do
  sleep 0.2
  "$(dirname "$0")/pi-progress" --current "$item" --total 10 --label "Processing items" --unit items
done
