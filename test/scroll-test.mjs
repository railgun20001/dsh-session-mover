/**
 * dsh-session-mover —— 边缘自动滚动算法的数值验证。
 *
 * 说明：`edgeScrollDelta` 运行在浏览器 bundle 里（`client.js` 的 factory 内），
 * 无法被 Node 直接 import；这里保留一份**逐行等价**的实现用于验证边界行为。
 * 修改 `client.js` 里的算法时，请同步这里的副本与常量。
 *
 * 运行：node test/scroll-test.mjs
 */

import assert from 'node:assert/strict'

/** 与 client.js 保持一致的三个常量。 */
const EDGE_SCROLL_BAND = 56
const EDGE_SCROLL_MAX_STEP = 18
const EDGE_SCROLL_MIN_STEP = 2

/**
 * 计算边缘自动滚动这一帧要走多少像素（与 client.js 的实现等价）。
 *
 * @param {{ top: number, bottom: number, height: number }} rect - 容器可视区矩形。
 * @param {number} y - 指针的视口纵坐标。
 * @returns 负数向上滚、正数向下滚、0 不滚。
 */
function edgeScrollDelta(rect, y) {
  if (rect.height <= 0) return 0
  const band = Math.min(EDGE_SCROLL_BAND, rect.height / 2)
  if (band <= 0) return 0
  if (y < rect.top + band) {
    const depth = Math.min(1, (rect.top + band - y) / band)
    return -Math.max(EDGE_SCROLL_MIN_STEP, Math.round(EDGE_SCROLL_MAX_STEP * depth))
  }
  if (y > rect.bottom - band) {
    const depth = Math.min(1, (y - (rect.bottom - band)) / band)
    return Math.max(EDGE_SCROLL_MIN_STEP, Math.round(EDGE_SCROLL_MAX_STEP * depth))
  }
  return 0
}

/** 一个典型的侧栏列表可视区：高 600，从 y=100 开始。 */
const rect = { top: 100, bottom: 700, height: 600 }

const cases = [
  ['列表正中间不滚动', 400, 0],
  ['顶部触发带刚进入 1px 时按最小速度向上', 155, -EDGE_SCROLL_MIN_STEP],
  ['越贴近顶部越快（半速附近）', 128, -9],
  ['越过上边界仍按上限向上', 40, -EDGE_SCROLL_MAX_STEP],
  ['底部触发带刚进入 1px 时按最小速度向下', 645, EDGE_SCROLL_MIN_STEP],
  ['越贴近底部越快（半速附近）', 672, 9],
  ['越过下边界仍按上限向下', 780, EDGE_SCROLL_MAX_STEP],
  ['容器高度为 0 时不滚动', null, 0],
]

let failed = 0
for (const [name, y, expected] of cases) {
  try {
    const value = y === null
      ? edgeScrollDelta({ top: 100, bottom: 100, height: 0 }, 100)
      : edgeScrollDelta(rect, y)
    assert.equal(value, expected, `${name}：期望 ${expected}，实际 ${value}`)
    console.log(`ok   ${name} => ${value}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error.message)
  }
}

if (failed > 0) {
  console.error(`\n${failed}/${cases.length} 个用例失败`)
  process.exitCode = 1
} else {
  console.log(`\n${cases.length} 个用例全部通过`)
}
