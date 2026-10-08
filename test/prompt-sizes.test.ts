import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pixelSize, toProviderSize, isSizeStyle } from '../src/prompt/sizes.ts'

test('pixels 形态：3:4 竖版映射到 1024x1536', () => {
  const size = toProviderSize({ aspectRatio: '3:4', resolution: '2k', sizeStyle: 'pixels' })
  assert.equal(size.size, '1024x1536')
  assert.equal(size.width, 1024)
  assert.equal(size.height, 1536)
  assert.equal(size.resolution, undefined)
})

test('pixels 形态：16:9 横版映射到 1536x1024', () => {
  const size = toProviderSize({ aspectRatio: '16:9', resolution: '1k', sizeStyle: 'pixels' })
  assert.equal(size.size, '1536x1024')
})

test('ratio-resolution 形态：比例串 + 独立分辨率（Apimart 契约）', () => {
  const size = toProviderSize({ aspectRatio: '1:1', resolution: '2k', sizeStyle: 'ratio-resolution' })
  assert.deepEqual(size, { size: '1:1', resolution: '2k' })
})

test('ignore 形态：不发送任何尺寸字段', () => {
  const size = toProviderSize({ aspectRatio: '4:3', resolution: '4k', sizeStyle: 'ignore' })
  assert.deepEqual(size, {})
})

test('三种形态互不串味：同比例不同形态产出不同字段集', () => {
  const pixels = toProviderSize({ aspectRatio: '9:16', resolution: '1k', sizeStyle: 'pixels' })
  const ratio = toProviderSize({ aspectRatio: '9:16', resolution: '1k', sizeStyle: 'ratio-resolution' })
  assert.notDeepEqual(pixels, ratio)
  assert.equal(pixels.size, '1024x1536')
  assert.equal(ratio.size, '9:16')
})

test('pixelSize 覆盖全部合法比例，且宽高为正偶数', () => {
  const ratios = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] as const
  for (const ratio of ratios) {
    const size = pixelSize(ratio)
    assert.ok(size.width > 0 && size.height > 0, ratio + ' 宽高必须为正')
    assert.equal(size.width % 2, 0, ratio + ' 宽必须为偶数')
    assert.equal(size.height % 2, 0, ratio + ' 高必须为偶数')
  }
})

test('isSizeStyle 只认三种合法形态', () => {
  assert.equal(isSizeStyle('pixels'), true)
  assert.equal(isSizeStyle('ratio-resolution'), true)
  assert.equal(isSizeStyle('ignore'), true)
  assert.equal(isSizeStyle('ratio'), false)
  assert.equal(isSizeStyle(undefined), false)
})
