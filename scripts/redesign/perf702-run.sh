#!/usr/bin/env bash
# #702 计时：10、50、112 章快照交替跑 perf702-reuse，再按蓝图条数跑 perf702-blueprints，最后各录一份 profile。
# 用法：bash scripts/redesign/perf702-run.sh <快照目录（含 10/ 50/ 112/）> <输出目录> [交替轮数，默认 2]
set -euo pipefail
fixtures=$1 out=$2 passes=${3:-2}
cd "$(dirname "$0")/../.."
mkdir -p "$out"
drive() { fnm exec --using=22.23.1 -- node scripts/redesign/drive.mjs "$@"; }
for pass in $(seq 1 "$passes"); do
  for size in 10 50 112; do
    PERF702_FIXTURE="$fixtures/$size" PERF702_FINALIZED=$size PERF702_ROUNDS=3 PERF702_LOG="$out/timing.jsonl" \
      drive --scenario perf702-reuse --out "$out/timing-$size-p$pass" > "$out/timing-$size-p$pass.out" 2>&1 || echo "失败：timing $size p$pass"
  done
done
for pass in $(seq 1 "$passes"); do
  for count in 20 100 200; do
    PERF702_BLUEPRINTS=$count PERF702_ROUNDS=3 PERF702_LOG="$out/blueprints.jsonl" \
      drive --scenario perf702-blueprints --out "$out/bp-$count-p$pass" > "$out/bp-$count-p$pass.out" 2>&1 || echo "失败：blueprints $count p$pass"
  done
done
for size in 10 50 112; do
  PERF702_FIXTURE="$fixtures/$size" PERF702_FINALIZED=$size PERF702_ROUNDS=1 PERF702_LOG="$out/profiled.jsonl" PERF702_PROFILE_DIR="$out/profiles" \
    drive --scenario perf702-reuse --out "$out/profile-$size" > "$out/profile-$size.out" 2>&1 || echo "失败：profile $size"
done
echo 完成
