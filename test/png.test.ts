import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { PNG_SIGNATURE, encodePng, placeholderPng, readPngSize } from '../src/provider/png.ts'

function idatOf(buffer: Buffer): Buffer {
  let offset = 8
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IDAT') return data
    offset += 12 + length
  }
  throw new Error('IDAT 段缺失')
}

test('encodePng 产出合法 PNG：签名 + IHDR + 可解压的 IDAT + IEND', () => {
  const buffer = encodePng(16, 8, () => ({ r: 10, g: 20, b: 30 }))
  assert.ok(buffer.subarray(0, 8).equals(PNG_SIGNATURE))
  assert.deepEqual(readPngSize(buffer), { width: 16, height: 8 })
  assert.equal(buffer.subarray(12, 16).toString('ascii'), 'IHDR')
  assert.equal(buffer.subarray(buffer.length - 8, buffer.length - 4).toString('ascii'), 'IEND')
  const raw = inflateSync(idatOf(buffer))
  assert.equal(raw.length, (16 * 3 + 1) * 8)
  assert.equal(raw[0], 0, '每行 filter 必须是 0')
})

test('placeholderPng 确定性：同 seed 同字节，异 seed 异字节', () => {
  const a = placeholderPng(24, 24, 7)
  const b = placeholderPng(24, 24, 7)
  const c = placeholderPng(24, 24, 8)
  assert.ok(a.equals(b))
  assert.ok(!a.equals(c))
  assert.deepEqual(readPngSize(a), { width: 24, height: 24 })
})

test('readPngSize 拒绝非 PNG 输入', () => {
  assert.equal(readPngSize(Buffer.from('not a png at all, definitely not')), undefined)
  assert.equal(readPngSize(Buffer.alloc(4)), undefined)
})
