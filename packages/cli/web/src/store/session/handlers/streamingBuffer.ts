/**
 * SSE 流式消息缓冲器
 *
 * 纯 class 实现，不依赖 React hooks。
 * 在事件分发层拦截高频 delta 事件，批量合并后再 flush 到 store。
 */

export interface StreamingBufferConfig {
  /** 批量刷新间隔（ms） */
  flushTimeout: number
}

const DEFAULT_CONFIG: StreamingBufferConfig = {
  flushTimeout: 80,
}

type FlushCallback = (bufferedDelta: string) => void

interface BufferChannel {
  buffer: string
  timer: ReturnType<typeof setTimeout> | null
  flushFn: FlushCallback | null
}

export class StreamingBuffer {
  private config: StreamingBufferConfig
  private channels: Map<string, BufferChannel> = new Map()

  constructor(config?: Partial<StreamingBufferConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 向指定通道追加 delta
   * @param channelKey 通道标识，如 "content:msgId:before"
   * @param delta 本次追加的文本
   * @param flushFn 满足条件时调用的刷新回调
   */
  append(channelKey: string, delta: string, flushFn: FlushCallback): void {
    let channel = this.channels.get(channelKey)
    if (!channel) {
      channel = { buffer: '', timer: null, flushFn: null }
      this.channels.set(channelKey, channel)
    }

    channel.buffer += delta
    channel.flushFn = flushFn

    if (!channel.timer) {
      channel.timer = setTimeout(() => {
        this.flushChannel(channelKey)
      }, this.config.flushTimeout)
    }
  }

  private flushChannel(channelKey: string): void {
    const channel = this.channels.get(channelKey)
    if (!channel || !channel.buffer) return

    const data = channel.buffer
    const fn = channel.flushFn

    channel.buffer = ''
    if (channel.timer) {
      clearTimeout(channel.timer)
      channel.timer = null
    }

    fn?.(data)
  }

  /** 原子排空所有通道 — stream 结束/取消时调用 */
  drainAll(): void {
    for (const [key] of this.channels) {
      this.flushChannel(key)
    }
    this.channels.clear()
  }

  /** 重置所有通道和 timer */
  reset(): void {
    for (const [, channel] of this.channels) {
      if (channel.timer) {
        clearTimeout(channel.timer)
      }
    }
    this.channels.clear()
  }
}

/** 模块级单例，供事件分发层和 slice 共用 */
export const globalStreamingBuffer = new StreamingBuffer()
