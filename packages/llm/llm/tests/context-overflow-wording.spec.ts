/**
 * A2 措辞矩阵：context-overflow 识别的扩宽正确性与反例边界（W2′ 验收用例）。
 *
 * 背景（W0 定谳）：网关实测措辞为 `The input is longer than the model's context length …`，
 * 而 `error.ts:68` 的 alternation 只收 `is larger than` ⇒ 五正则 5/5 漏判 ⇒ adapter 不赋
 * CONTEXT_WINDOW_EXCEEDED_CODE ⇒ overflow 恢复分支（compaction-basic index.ts:183）从未进入。
 * W2′ 仅扩宽 :68 一行（is\s+(?:longer|larger)\s+than），本 spec 固化其识别面与反例边界。
 */
import { describe, expect, it } from 'vitest'

import { isContextWindowExceededError } from '../src/error'

/**
 * 运行时形态（一层解码后 matcher 实际看到的 message）。
 *
 * 留档出处（2026-09-28 由三份会话档案逐条复核，非转述）：
 * ① `bead14916ec206f5451241a41bc3c894` = **13bbf5c9 turn 179**，
 *    路由 `modlens-huoshan-engine` / `deepseek-v4-flash`（huoshan 网关）；
 * ② `622640262ca199a213100bf7a1141538` = **027ec7cb turn 737**，
 *    路由 `modlens-commandcode` / `deepseek/deepseek-v4.1-flash`（第二网关，同构措辞）。
 * 两例均为 `contextWindow = 1_000_000` 虚高下的真实 400。
 */
const GATEWAY_LONGER_HUOSHAN_13BBF5C9 =
  '400: {"message":"{\\"message\\":\\"The input is longer than the model\'s context length trace_id: bead14916ec206f5451241a41bc3c894\\",\\"type\\":\\"invalid_request_error\\"}\\n","type":"invalid_request_error"}'

const GATEWAY_LONGER_COMMANDCODE_027EC7CB =
  '400: {"message":"{\\"message\\":\\"The input is longer than the model\'s context length trace_id: 622640262ca199a213100bf7a1141538\\",\\"type\\":\\"invalid_request_error\\"}\\n","type":"invalid_request_error"}'

describe('A2 · context-overflow 措辞矩阵', () => {
  describe('① longer 变体（W2′ 新增命中面）', () => {
    it('命中网关实测措辞（含中转双层 JSON 包裹）', () => {
      expect(isContextWindowExceededError(GATEWAY_LONGER_HUOSHAN_13BBF5C9)).toBe(true)
    })

    it('命中第二网关同构原文（027ec7cb turn 737 / modlens-commandcode 路由）', () => {
      expect(isContextWindowExceededError(GATEWAY_LONGER_COMMANDCODE_027EC7CB)).toBe(true)
    })

    it('命中裸句（去包裹后的 message 文本）', () => {
      expect(isContextWindowExceededError(
        "The input is longer than the model's context length trace_id: 6226",
      )).toBe(true)
    })

    it('命中变体主语（prompt / request / messages）', () => {
      expect(isContextWindowExceededError('the prompt is longer than the context window')).toBe(true)
      expect(isContextWindowExceededError('request is longer than model context length')).toBe(true)
    })
  })

  describe('② larger 变体（既有命中面，不得因扩宽而回退）', () => {
    it('既有 larger 措辞仍命中', () => {
      expect(isContextWindowExceededError('the input is larger than the model context length')).toBe(true)
    })
  })

  describe('③ 既有规范措辞（对照基线，零回归）', () => {
    it('structured code 形态', () => {
      expect(isContextWindowExceededError('context_length_exceeded maximum context length')).toBe(true)
      expect(isContextWindowExceededError('This model maximum context length is 128000 tokens')).toBe(true)
    })

    it('too large/long for … context 形态', () => {
      expect(isContextWindowExceededError('the request is too large for the model context window')).toBe(true)
      expect(isContextWindowExceededError('input is too long for this model')).toBe(true)
    })

    it('四网关原文：429 限流（非 context 类，must be false）', () => {
      expect(isContextWindowExceededError(
        '429: {"code":"AccountRateLimitExceeded","message":"Requests are too frequent. Please reduce your request frequency","type":"TooManyRequests"}',
      )).toBe(false)
      expect(isContextWindowExceededError(
        '429: {"type":"GoUsageLimitError","message":"allocated quota exceeded"}',
      )).toBe(false)
    })
  })

  describe('⑤ 反例：非 context 语义的 longer than 不得命中', () => {
    it('无 context 对象', () => {
      expect(isContextWindowExceededError('the response is longer than expected')).toBe(false)
      expect(isContextWindowExceededError('output longer than the input')).toBe(false)
    })

    it('有 longer than 但对象非模型 context', () => {
      expect(isContextWindowExceededError('the input is longer than the timeout allows')).toBe(false)
      expect(isContextWindowExceededError('the prompt is longer than the response')).toBe(false)
    })

    it('仅出现 context 而无比较语义', () => {
      expect(isContextWindowExceededError('context length is 128000 tokens')).toBe(false)
      expect(isContextWindowExceededError('building context for the model')).toBe(false)
    })
  })
})
