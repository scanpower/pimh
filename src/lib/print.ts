import * as Print from 'expo-print';
import { Platform } from 'react-native';
import { PrinterConfig } from '../types';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Matches a base64 PDF data URI anywhere in a string, e.g. what print_item_labels returns:
// "data:application/pdf;filename=generated.pdf;base64,JVBERi0...". The `;filename=...` param
// (and any others) aren't valid in the strict `data:<type>;base64,<data>` form expo-print's
// `uri` option expects, so they're stripped before use — only the base64 flag and payload matter.
const PDF_DATA_URI_RE = /data:application\/pdf[^,]*,[A-Za-z0-9+/=]+/i;

function extractPdfDataUri(content: string): string | null {
  const match = content.match(PDF_DATA_URI_RE);
  if (!match) {
    if (/application\/pdf/i.test(content)) {
      console.warn('[print] content mentions application/pdf but did not match the expected data URI shape');
    }
    return null;
  }
  const commaIdx = match[0].indexOf(',');
  const params = match[0].slice('data:application/pdf'.length, commaIdx);
  if (!/base64/i.test(params)) {
    console.warn(`[print] found a PDF data URI without a base64 flag (params: "${params}") — not supported`);
    return null; // only base64-encoded PDFs are supported
  }
  return `data:application/pdf;base64,${match[0].slice(commaIdx + 1)}`;
}

function describeTarget(printer: PrinterConfig | null): string {
  return printer ? `saved printer "${printer.name}" (${printer.url})` : 'system print picker (no default printer saved)';
}

/** Describes exactly what one printContent() call sent and where — shown in the app for debugging. */
export interface PrintCallInfo {
  mode: 'pdf' | 'text';
  target: string;
  detail: string;
}

/** Thrown by printContent() on failure; carries the call info so the caller can still display it. */
export class PrintCallError extends Error {
  call: PrintCallInfo;
  constructor(message: string, call: PrintCallInfo) {
    super(message);
    this.call = call;
  }
}

export interface PrintCallResult {
  call: PrintCallInfo;
}

/**
 * Prints one piece of tool-result content to the system print dialog (expo-print / AirPrint).
 * A PDF data URI (as returned by tools like print_item_labels) is printed as an actual PDF via
 * expo-print's `uri` option; anything else is printed as plain text via its `html` option. If a
 * printer was saved via selectPrinter(), printing goes straight to it — otherwise the OS printer
 * picker opens.
 *
 * Returns (or, on failure, attaches to the thrown PrintCallError) a PrintCallInfo describing
 * exactly what was sent and where — expo-print's promise can resolve successfully on iOS even
 * when the physical printer never receives/renders the job, so this call info is the only way
 * to confirm what the app actually attempted.
 */
export async function printContent(content: string, printer: PrinterConfig | null): Promise<PrintCallResult> {
  const pdfUri = extractPdfDataUri(content);
  const target = describeTarget(printer);
  const call: PrintCallInfo = pdfUri
    ? { mode: 'pdf', target, detail: `PDF data URI, ${pdfUri.length} chars (base64 payload)` }
    : {
        mode: 'text',
        target,
        detail: `${content.length} chars: ${content.slice(0, 120)}${content.length > 120 ? '…' : ''}`,
      };

  console.log(`[print] ${call.mode} → ${call.target} — ${call.detail}`);
  try {
    if (pdfUri) {
      await Print.printAsync({ uri: pdfUri, printerUrl: printer?.url ?? undefined });
    } else {
      const html =
        '<html><body><pre style="font-family: Menlo, monospace; font-size: 13px; ' +
        'white-space: pre-wrap; word-wrap: break-word;">' +
        escapeHtml(content) +
        '</pre></body></html>';
      await Print.printAsync({ html, printerUrl: printer?.url ?? undefined });
    }
    console.log(`[print] Print.printAsync resolved (${call.mode})`);
    return { call };
  } catch (e: any) {
    console.error(`[print] Print.printAsync rejected (${call.mode}):`, e);
    throw new PrintCallError(e?.message ?? String(e), call);
  }
}

/** Lets the user pick a default printer ahead of time so future prints skip the picker. iOS only. */
export async function selectPrinter(): Promise<PrinterConfig | null> {
  if (Platform.OS !== 'ios') return null;
  const printer = await Print.selectPrinterAsync();
  console.log('[print] selectPrinterAsync() resolved:', printer);
  return printer;
}
