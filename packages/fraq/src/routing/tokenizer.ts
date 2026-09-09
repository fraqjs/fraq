import type { IncomingSegment } from '../protocol/types';

export type Token = string | Exclude<IncomingSegment, { type: 'text' }>;

const WHITESPACE_CHARS = new Set([' ', '\t', '\n', '\r', '\v', '\f', '\u00A0', '\u3000']);

export interface TokenizerState {
  offset: number;
  subOffset?: number;
}

export class Tokenizer {
  private offset: number = 0;
  // 如果在一个文本消息段内，则 subOffset 表示当前 token 在该文本消息段内的偏移量；
  // 如果不在文本消息段内，则 subOffset 应该为 undefined
  private subOffset?: number = undefined;

  constructor(private readonly segments: IncomingSegment[]) {}

  getState(): TokenizerState {
    return { offset: this.offset, subOffset: this.subOffset };
  }

  setState(state: TokenizerState): void {
    this.offset = state.offset;
    this.subOffset = state.subOffset;
  }

  hasNext(): boolean {
    return this.findNextPosition() !== undefined;
  }

  peek(): Token | undefined {
    const position = this.findNextPosition();
    if (position === undefined) {
      return undefined;
    }

    const segment = this.segments[position.offset];
    if (segment.type === 'text') {
      return this.readTextToken(segment.data.text, position.subOffset ?? 0);
    }

    return segment;
  }

  next(): Token | undefined {
    const position = this.findNextPosition();
    if (position === undefined) {
      return undefined;
    }

    const segment = this.segments[position.offset];
    if (segment.type !== 'text') {
      this.offset = position.offset + 1;
      this.subOffset = undefined;
      return segment;
    }

    const subOffset = position.subOffset ?? 0;
    const token = this.readTextToken(segment.data.text, subOffset);
    const tokenEnd = subOffset + token.length;
    const nextSubOffset = this.findTextTokenStart(segment.data.text, tokenEnd);

    if (nextSubOffset < segment.data.text.length) {
      this.offset = position.offset;
      this.subOffset = nextSubOffset;
    } else {
      this.offset = position.offset + 1;
      this.subOffset = undefined;
    }

    return token;
  }

  isGreedyAvailable(): boolean {
    const position = this.findNextPosition();
    if (position === undefined) {
      return false;
    }

    return this.segments[position.offset].type === 'text';
  }

  greedy(): string {
    const position = this.findNextPosition();
    if (position === undefined) {
      throw new Error('Greedy token is not available');
    }

    const segment = this.segments[position.offset];
    if (segment.type !== 'text') {
      throw new Error('Greedy token is not available');
    }

    const token = segment.data.text.slice(position.subOffset ?? 0);
    this.offset = position.offset + 1;
    this.subOffset = undefined;

    return token;
  }

  isCatchAllAvailable(): boolean {
    return this.findNextPosition() !== undefined;
  }

  catchAll(): IncomingSegment[] {
    const position = this.findNextPosition();
    if (position === undefined) {
      throw new Error('Catch-all token is not available');
    }

    const segment = this.segments[position.offset];
    const segments = this.segments.slice(position.offset);

    if (segment.type === 'text') {
      segments[0] = {
        ...segment,
        data: {
          ...segment.data,
          text: segment.data.text.slice(position.subOffset ?? 0),
        },
      };
    }

    this.offset = this.segments.length;
    this.subOffset = undefined;

    return segments;
  }

  consumeMention(userId: number): boolean {
    const token = this.peek();
    if (typeof token === 'object' && token !== null && token.type === 'mention' && token.data.user_id === userId) {
      this.next();
      return true;
    }

    return false;
  }

  consumeTextToken(expected: string): boolean {
    if (expected.length === 0) {
      return false;
    }

    const position = this.findNextPosition();
    if (position === undefined) {
      return false;
    }

    const segment = this.segments[position.offset];
    if (segment.type !== 'text') {
      return false;
    }

    const text = segment.data.text;
    const tokenStart = position.subOffset ?? 0;
    if (!text.startsWith(expected, tokenStart)) {
      return false;
    }

    const tokenEnd = tokenStart + expected.length;
    if (tokenEnd < text.length && !WHITESPACE_CHARS.has(text[tokenEnd])) {
      return false;
    }

    // A name containing separators cannot represent a single token.
    for (let offset = tokenStart; offset < tokenEnd; offset++) {
      if (WHITESPACE_CHARS.has(text[offset])) {
        return false;
      }
    }

    const nextSubOffset = this.findTextTokenStart(text, tokenEnd);
    if (nextSubOffset < text.length) {
      this.offset = position.offset;
      this.subOffset = nextSubOffset;
    } else {
      this.offset = position.offset + 1;
      this.subOffset = undefined;
    }

    return true;
  }

  consumeTextPrefix(prefix: string): boolean {
    if (prefix.length === 0) {
      return false;
    }

    const position = this.findNextPosition();
    if (position === undefined) {
      return false;
    }

    const segment = this.segments[position.offset];
    if (segment.type !== 'text') {
      return false;
    }

    const prefixStart = position.subOffset ?? 0;
    if (!segment.data.text.startsWith(prefix, prefixStart)) {
      return false;
    }

    const prefixEnd = prefixStart + prefix.length;
    const nextSubOffset = this.findTextTokenStart(segment.data.text, prefixEnd);
    if (nextSubOffset < segment.data.text.length) {
      this.offset = position.offset;
      this.subOffset = nextSubOffset;
    } else {
      this.offset = position.offset + 1;
      this.subOffset = undefined;
    }

    return true;
  }

  private findNextPosition(): TokenizerState | undefined {
    let offset = this.offset;
    let subOffset = this.subOffset;

    while (offset < this.segments.length) {
      const segment = this.segments[offset];
      if (segment.type !== 'text') {
        return { offset, subOffset: undefined };
      }

      const tokenStart = this.findTextTokenStart(segment.data.text, subOffset ?? 0);
      if (tokenStart < segment.data.text.length) {
        return { offset, subOffset: tokenStart };
      }

      offset += 1;
      subOffset = undefined;
    }

    return undefined;
  }

  private findTextTokenStart(text: string, from: number): number {
    let offset = from;
    while (offset < text.length && WHITESPACE_CHARS.has(text[offset])) {
      offset += 1;
    }

    return offset;
  }

  private readTextToken(text: string, from: number): string {
    let offset = from;
    while (offset < text.length && !WHITESPACE_CHARS.has(text[offset])) {
      offset += 1;
    }

    return text.slice(from, offset);
  }
}
