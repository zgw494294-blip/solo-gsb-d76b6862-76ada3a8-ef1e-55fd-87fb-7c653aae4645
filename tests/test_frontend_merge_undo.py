"""前端误合并撤销回归测试的 pytest 封装。

用例本体在 tests/test_merge_undo_ownership.js：用最小 DOM 桩在 Node 虚拟机中加载
真实的 app/static/app.js，驱动「合并所选」与「合并撤销」面板的真实事件处理器，覆盖：
- 每次合并成功建立撤销记录（两条原文、保留条款合并后正文与其余全部改写引用来源的
  前后内部正文；两条原文自身不进 rewrites），记录仅存本页内存（重新导入 / 恢复
  存档清空），合并失败不产生记录；
- 撤销经 POST /api/merge/undo：沿用写稿协调层（互斥、携带最新 lock_ids、成功回包
  按最新锁定集合核验、旧响应隔离），成功后记录移除且身份上界不回退、之后无关校订
  保留；422 / 409（冲突或锁定保护）时草稿与记录均保留；
- 未完成编辑 / 拆分 / 写稿时不可撤销，撤销后超过 40 条前端拦截，记录与当前稿对
  不上时本地不发请求（权威核对仍在服务端）。
这里通过 node --test 运行它；环境没有 Node 时跳过（后端接口测试不受影响）。
"""

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


@pytest.mark.skipif(shutil.which("node") is None, reason="需要 Node 运行前端单测")
def test_merge_undo_ownership_frontend():
    r = subprocess.run(
        ["node", "--test", str(ROOT / "tests" / "test_merge_undo_ownership.js")],
        capture_output=True,
        text=True,
    )
    assert r.returncode == 0, r.stdout + r.stderr
