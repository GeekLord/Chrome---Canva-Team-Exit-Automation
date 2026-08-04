/**
 * Client-side file save for log exports.
 *
 * Uses a Blob URL plus an anchor click from an extension page, which needs no
 * `downloads` permission and never sends the data anywhere.
 */

export function downloadText(filename: string, mimeType: string, contents: string): void {
  const blob = new Blob([contents], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';

  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  // Give Chrome time to start the save before releasing the URL.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
