/**
 * Decode hook stdin bytes into a JSON-parseable string.
 *
 * IDEs deliver hook payloads as raw bytes whose encoding is not guaranteed,
 * especially on Windows. This module centralizes the decoding strategy so it
 * can be unit-tested independently of the hooks-cli entry point.
 */

import iconv from 'iconv-lite';
import { logger } from './logger.js';

/**
 * Check if a string contains corrupted markers that indicate an encoding issue.
 * A single `?` is legitimate; multiple consecutive `?` right after a quoted key
 * value strongly suggests a lossy code-page conversion.
 */
export function containsInvalidChars(str: string): boolean {
  return /:"(\?{2,})"/.test(str);
}

/**
 * Try to decode a buffer with multiple encodings, returning the first decode
 * that yields valid JSON. Falls back to UTF-8 (possibly corrupted) when nothing
 * parses, so the caller still gets a string to surface in error logs.
 */
export function decodeBufferWithFallback(buffer: Buffer): string {
  // Remove UTF-8 BOM if present (EF BB BF)
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    logger.debug('ENCODING', 'Detected and removing UTF-8 BOM');
    buffer = buffer.slice(3);
  }

  // Log raw bytes for debugging encoding issues
  logger.debug('ENCODING', 'Raw buffer info', {
    length: buffer.length,
    hexPreview: buffer.slice(0, 200).toString('hex'),
    utf8Preview: buffer.toString('utf8').substring(0, 200)
  });

  // First try UTF-8 (most common). Also strip a leading U+FEFF character:
  // on UTF-8 (cp65001) Windows, PowerShell prepends a BOM to the piped hook
  // payload, which survives as U+FEFF after decoding and breaks JSON.parse
  // ("Unexpected token '﻿'"). The byte-level strip above handles a raw EF BB BF
  // prefix; this catches the character form regardless of how it arrived.
  let utf8Result = buffer.toString('utf8');
  if (utf8Result.charCodeAt(0) === 0xFEFF) {
    utf8Result = utf8Result.slice(1);
  }

  // Check if UTF-8 decoding looks valid (no replacement characters)
  // UTF-8 decoding errors typically result in � (U+FFFD) or corrupted text
  if (!utf8Result.includes('\uFFFD') && !containsInvalidChars(utf8Result)) {
    try {
      JSON.parse(utf8Result);
      logger.debug('ENCODING', 'Decoded as UTF-8 successfully');
      return utf8Result;
    } catch {
      // UTF-8 valid but not valid JSON, continue to try other encodings
    }
  }

  // Try GBK (Windows Chinese encoding)
  try {
    const gbkResult = iconv.decode(buffer, 'gbk');
    JSON.parse(gbkResult);
    logger.debug('ENCODING', 'Decoded as GBK successfully', {
      gbkPreview: gbkResult.substring(0, 200)
    });
    return gbkResult;
  } catch {
    // GBK decoding failed or not valid JSON
  }

  // Try GB18030 (extended Chinese encoding)
  try {
    const gb18030Result = iconv.decode(buffer, 'gb18030');
    JSON.parse(gb18030Result);
    logger.debug('ENCODING', 'Decoded as GB18030 successfully');
    return gb18030Result;
  } catch {
    // GB18030 decoding failed or not valid JSON
  }

  // Last resort: repair UTF-8 ↔ GBK/GB18030 "double-encoding" mojibake.
  //
  // On Chinese (cp936) Windows, Cursor pipes hook JSON through PowerShell
  // ($input | cmd /c ...). PowerShell decodes Cursor's UTF-8 bytes using the
  // cp936 console encoding (producing mojibake like "鍝﹀摝"), then re-emits it
  // as UTF-8 to the child process. So the bytes we receive are the UTF-8
  // encoding of the mojibake string. We reverse it by re-encoding the mojibake
  // back to the Chinese codepage and decoding the result as UTF-8.
  //
  // This block only runs after every direct decode failed to JSON.parse, so it
  // cannot change behavior for machines whose input already decodes cleanly.
  for (const cp of ['gbk', 'gb18030'] as const) {
    try {
      const repaired = iconv.decode(iconv.encode(utf8Result, cp), 'utf8');
      JSON.parse(repaired);
      logger.debug('ENCODING', 'Recovered from UTF-8/Chinese double-encoding', { codepage: cp });
      return repaired;
    } catch {
      // Not a recoverable double-encoding for this codepage
    }
  }

  // Fallback to UTF-8 even if it might have issues
  logger.debug('ENCODING', 'Fallback to UTF-8', { hasIssues: containsInvalidChars(utf8Result) });
  return utf8Result;
}
