import { UAParser } from 'ua-parser-js';
import { isBot } from 'ua-parser-js/bot-detection';
import { ToolError, type ToolLogic } from '../types';

export interface UserAgentParserResult {
  [label: string]: string;
}

/** Common bot/crawler substrings as a fallback when ua-parser-js's own
 * bot-detection submodule doesn't recognize a short/atypical client string
 * (e.g. bare "wget/1.21" or an unlisted "*Spider/1.0" crawler). Deliberately
 * not word-bounded — real bot UAs frequently glue the hint onto another word
 * (Googlebot, AhrefsBot, SomeUnknownSpider). */
const BOT_HINTS = /(bot|crawler|spider|curl|wget)/i;

function nameAndVersion(name?: string, version?: string): string {
  if (!name) return 'Unknown';
  return version ? `${name} ${version}` : name;
}

function deviceLabel(device: { vendor?: string; model?: string; type?: string }): string {
  const { vendor, model, type } = device;
  if (!vendor && !model && !type) return 'Desktop (no device markers)';
  const parts = [vendor, model].filter(Boolean).join(' ');
  return type ? `${parts || 'Unknown'} (${type})` : parts || 'Unknown';
}

export const run: ToolLogic<string, UserAgentParserResult, Record<string, unknown>>['run'] = (
  input
) => {
  const ua = (input ?? '').trim();
  if (!ua)
    throw new ToolError(
      'empty-input',
      'Enter a User-Agent string to decode.',
      'Paste a User-Agent string — find yours by searching "what is my user agent".'
    );

  const result = new UAParser(ua).getResult();

  const out: UserAgentParserResult = {
    Browser: nameAndVersion(result.browser.name, result.browser.version),
    Engine: nameAndVersion(result.engine.name, result.engine.version),
    OS: nameAndVersion(result.os.name, result.os.version),
    Device: deviceLabel(result.device),
  };

  if (result.cpu.architecture) {
    out['CPU architecture'] = result.cpu.architecture;
  }

  if (isBot(ua) || BOT_HINTS.test(ua)) {
    out['Bot?'] = 'Yes — this looks like a known crawler/bot, not a browser.';
  }

  return out;
};

export default { run } satisfies ToolLogic<string, UserAgentParserResult, Record<string, unknown>>;
