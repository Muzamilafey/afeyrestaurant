/** Browser fallback printing for 58/80mm receipts. The local bridge is used for ESC/POS printers when configured. */
export function printText(text: string, title = 'Receipt') {
  const w = window.open('', '_blank', 'width=380,height=600');
  if (!w) throw new Error('Pop-up blocked — allow pop-ups to print');
  const esc = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  w.document.write(`<!doctype html><html><head><title>${title}</title><style>@page{size:80mm auto;margin:3mm}body{font:12px/1.35 'Courier New',monospace;margin:0;white-space:pre-wrap}</style></head><body>${esc}<script>window.onload=()=>{window.print();setTimeout(()=>window.close(),300)}</script></body></html>`);
  w.document.close();
}
