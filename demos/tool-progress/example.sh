#!/usr/bin/env bash
for item in {1..10}; do
  printf '<<pi-progress>> {"version":1,"scopeId":"items:1","scopeLabel":"Processing items","current":%d,"total":10,"unit":"items","totalKind":"fixed"}\n' "$item"
done
