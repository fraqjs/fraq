import {
  type LogBatch,
  type LogCursor,
  type LogEntry,
  MAX_LOG_BYTES,
  MAX_LOG_LINE_BYTES,
  MAX_LOG_LINES,
} from '@fraqjs/cli-protocol';

import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';

const truncation = ' … [truncated]';

export class LogRegistry {
  readonly session = randomUUID();
  private readonly entries: LogEntry[] = [];
  private bytes = 0;
  private sequence = 0;

  close(): void {
    this.entries.length = 0;
    this.bytes = 0;
  }

  read(cursor: LogCursor = {}, maxBytes = Infinity): LogBatch {
    const sameSession = cursor.session === this.session;
    const after = sameSession ? (cursor.after ?? 0) : 0;
    const first = this.entries[0]?.sequence ?? this.sequence + 1;
    const gap =
      (cursor.session !== undefined && !sameSession) || (after > 0 && after < first - 1) || after > this.sequence;
    const entries: LogEntry[] = [];
    let bytes = 0;
    for (const entry of this.entries) {
      if (entry.sequence <= (gap ? 0 : after)) continue;
      const size = maxBytes === Infinity ? 0 : Buffer.byteLength(JSON.stringify(entry));
      if (entries.length && bytes + size > maxBytes) break;
      entries.push(entry);
      bytes += size;
    }
    return { session: this.session, entries, cursor: entries.at(-1)?.sequence ?? this.sequence, gap };
  }

  error(text: string): void {
    this.message(text, 'stderr');
  }

  message(text: string, stream: LogEntry['stream'] = 'stdout'): void {
    const output = this.output('cli', stream);
    output.end(`${text}\n`);
    if (stream === 'stderr') console.error(text);
    else console.log(text);
  }

  // Each process stream owns its decoder and partial line. Even an unterminated
  // line is bounded; excess text is discarded until the next line separator.
  output(source: LogEntry['source'], stream: LogEntry['stream']): Writable {
    const decoder = new StringDecoder('utf8');
    let line = '';
    let bytes = 0;
    let truncated = false;
    let carriageReturn = false;
    const flush = () => {
      let text = stripVTControlCharacters(line);
      if (truncated) {
        const characters = Array.from(text);
        let textBytes = Buffer.byteLength(text);
        while (textBytes > MAX_LOG_LINE_BYTES - Buffer.byteLength(truncation)) {
          textBytes -= Buffer.byteLength(characters.pop() ?? '');
        }
        text = characters.join('') + truncation;
      }
      const entry: LogEntry = {
        session: this.session,
        sequence: ++this.sequence,
        time: Date.now(),
        source,
        stream,
        text,
        bytes: Buffer.byteLength(text),
        truncated,
      };
      this.entries.push(entry);
      this.bytes += entry.bytes;
      while (this.entries.length > MAX_LOG_LINES || this.bytes > MAX_LOG_BYTES) {
        this.bytes -= this.entries.shift()?.bytes ?? 0;
      }
      line = '';
      bytes = 0;
      truncated = false;
    };
    const consume = (text: string) => {
      for (const character of text) {
        if (character === '\n' && carriageReturn) {
          carriageReturn = false;
          continue;
        }
        carriageReturn = character === '\r';
        if (character === '\r' || character === '\n') {
          flush();
          continue;
        }
        if (truncated) continue;
        const next = Buffer.byteLength(character);
        if (bytes + next > MAX_LOG_LINE_BYTES) {
          truncated = true;
          continue;
        }
        bytes += next;
        line += character;
      }
    };
    return new Writable({
      write(chunk: Buffer, _encoding, done) {
        consume(decoder.write(chunk));
        done();
      },
      final(done) {
        consume(decoder.end());
        if (line || truncated) flush();
        done();
      },
    });
  }
}
