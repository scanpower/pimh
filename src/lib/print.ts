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
  if (!match) return null;
  const commaIdx = match[0].indexOf(',');
  const params = match[0].slice('data:application/pdf'.length, commaIdx);
  if (!/base64/i.test(params)) return null; // only base64-encoded PDFs are supported
  return `data:application/pdf;base64,${match[0].slice(commaIdx + 1)}`;
}

/**
 * Prints one piece of tool-result content to the system print dialog (expo-print / AirPrint).
 * A PDF data URI (as returned by tools like print_item_labels) is printed as an actual PDF via
 * expo-print's `uri` option; anything else is printed as plain text via its `html` option. If a
 * printer was saved via selectPrinter(), printing goes straight to it — otherwise the OS printer
 * picker opens.
 */
export async function printContent(content: string, printer: PrinterConfig | null): Promise<void> {
  const pdfUri = extractPdfDataUri(content);
  if (pdfUri) {
    await Print.printAsync({ uri: pdfUri, printerUrl: printer?.url });
    return;
  }
  const html =
    '<html><body><pre style="font-family: Menlo, monospace; font-size: 13px; ' +
    'white-space: pre-wrap; word-wrap: break-word;">' +
    escapeHtml(content) +
    '</pre></body></html>';
  await Print.printAsync({ html, printerUrl: printer?.url });
}

/** Lets the user pick a default printer ahead of time so future prints skip the picker. iOS only. */
export async function selectPrinter(): Promise<PrinterConfig | null> {
  if (Platform.OS !== 'ios') return null;
  return Print.selectPrinterAsync();
}
