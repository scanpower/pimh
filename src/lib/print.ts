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

/**
 * Sends plain text to the system print dialog (expo-print / AirPrint). If a printer was saved
 * via selectPrinter(), printing goes straight to it — otherwise the OS printer picker opens.
 */
export async function printText(content: string, printer: PrinterConfig | null): Promise<void> {
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
