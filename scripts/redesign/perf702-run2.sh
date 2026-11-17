#!/usr/bin/env bash
# #702 第二轮：手动写法快照（10/50/112）交替计时；两种 112 章作品上的主进程阻塞证明（先不录、再录 profile）；AI 生成 50/200 章蓝图。
# 用法：bash scripts/redesign/perf702-run2.sh <手动快照目录> <批量快照目录> <输出目录>
set -euo pipefail
# 相对路径按调用处解析，之后才 cd 到仓库根。
hand=$(cd "$1" && pwd)
batch=$(cd "$2" && pwd)
out=$(mkdir -p "$3" && cd "$3" && pwd)
failed=0
cd "$(dirname "$0")/../.."
drive() { fnm exec --using=22.23.1 -- node scripts/redesign/drive.mjs "$@"; }
for pass in 1 2; do
  for size in 10 50 112; do
    PERF702_FIXTURE="$hand/$size" PERF702_FINALIZED=$size PERF702_ROUNDS=3 PERF702_LOG="$out/hand-timing.jsonl" \
      drive --scenario perf702-reuse --out "$out/hand-$size-p$pass" > "$out/hand-$size-p$pass.out" 2>&1 || { echo "失败：hand $size p$pass"; failed=1; }
  done
done
for kind in hand batch; do
  dir=$hand; [ "$kind" = batch ] && dir=$batch
  PERF702_FIXTURE="$dir/112" PERF702_FINALIZED=112 PERF702_LOG="$out/contention-$kind.jsonl" \
    drive --scenario perf702-contention --out "$out/contention-$kind" > "$out/contention-$kind.out" 2>&1 || { echo "失败：contention $kind"; failed=1; }
done
PERF702_FIXTURE="$hand/112" PERF702_FINALIZED=112 PERF702_LOG="$out/contention-hand-profiled.jsonl" PERF702_PROFILE_DIR="$out/profiles" PERF702_PROFILE='^(contention|112-r1-open)' \
  drive --scenario perf702-contention --out "$out/contention-hand-profiled" > "$out/contention-hand-profiled.out" 2>&1 || { echo "失败：contention profiled"; failed=1; }
for count in 50 200; do
  PERF702_BLUEPRINTS=$count PERF702_ROUNDS=3 PERF702_LOG="$out/bpgen.jsonl" \
    drive --scenario perf702-bpgen --out "$out/bpgen-$count" > "$out/bpgen-$count.out" 2>&1 || { echo "失败：bpgen $count"; failed=1; }
done
[ "$failed" = 0 ] || { echo 有失败，见上面的「失败」行; exit 1; }
echo 完成
